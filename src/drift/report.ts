import { resolve } from 'node:path';
import type { FlintConfig } from '../schemas/config.js';
import type { ScreenModel } from '../schemas/screen-model.js';
import type { ScreenModelDiff } from '../explorer/screen-model-store.js';
import { writeModel } from '../explorer/screen-model-store.js';
import { scanSuite } from '../indexer/scan.js';
import { indexPath, writeIndex } from '../indexer/store.js';
import { planHistoryCoverage, readAllPlans } from '../planner/store.js';
import { readFeatureSpec } from '../planner/feature-spec.js';
import { resolveDialect } from '../generator/dialects/index.js';
import {
  pruneToModel,
  readPageObjectRecords,
  writePageObjectRecords,
  type StoredPageObject,
} from '../generator/page-object-store.js';
import type { BatchFeature } from '../generator/batch.js';
import { applyWrites, planWrites } from '../integrator/writer.js';
import { runCompileGate } from '../integrator/gate.js';
import { discoverSuiteFiles } from '../integrator/suite-files.js';
import type { Logger } from '../shared/logger.js';
import { analyzeDrift, breakingTests, formatImpact, type DriftImpact } from './impact.js';
import { regeneratePageObjects } from './regenerate.js';

/**
 * Drift mode's CLI half: read the suite, say what the change costs, and — only
 * when asked — repair the page objects.
 *
 * Kept out of `explore.ts` on purpose. The command's job is to drive a browser;
 * this one's is to reason about a suite, and they should be separately callable
 * (V2 exposes stages as agent tools). `explore --diff` wires the two together
 * in four lines.
 */

export interface DriftReportOptions {
  projectRoot: string;
  config: FlintConfig;
  /** The stored model — what the suite was generated from. */
  before: ScreenModel;
  /** The model the crawl just produced. */
  after: ScreenModel;
  diff: ScreenModelDiff;
  /** Where the model would be written if the drift is accepted. */
  modelFile: string;
  /** Regenerate page objects against the new model. */
  fix: boolean;
  logger: Logger;
}

export interface DriftReportOutcome {
  impact: DriftImpact;
  /** True when `--fix-page-objects` regenerated and the suite still compiles. */
  resolved: boolean;
}

export function reportDrift(options: DriftReportOptions): DriftReportOutcome {
  const { projectRoot, config, logger } = options;
  const suiteRoot = resolve(projectRoot, config.suiteDir);

  // Scan fresh rather than trusting `.flint/suite-index.json`: the whole
  // report is about the suite as it is on disk right now, and a stale index
  // would name tests that no longer exist.
  const index = scanSuite({
    projectRoot,
    suiteDir: config.suiteDir,
    logger,
    planHistory: planHistoryCoverage(projectRoot),
  }).index;
  const records = readPageObjectRecords(projectRoot);

  const impact = analyzeDrift({ diff: options.diff, before: options.before, index, records });

  console.log('');
  console.log(formatImpact(impact));

  if (!options.fix) {
    printNextSteps(impact);
    return { impact, resolved: false };
  }

  return { impact, resolved: fixPageObjects(options, suiteRoot, records) };
}

/**
 * Re-emit page objects from the new model, leaving specs untouched, and only
 * keep the result if the untouched specs still compile against it.
 */
function fixPageObjects(
  options: DriftReportOptions,
  suiteRoot: string,
  records: StoredPageObject[],
): boolean {
  const { projectRoot, config, logger } = options;

  const plans = readAllPlans(projectRoot);
  if (plans.length === 0) {
    console.log('');
    console.log('Nothing to regenerate: no stored plans under .flint/plans.');
    console.log('Run `flint ci` to plan and generate from scratch.');
    return false;
  }

  const features: BatchFeature[] = plans.map((plan) => ({
    featureId: plan.featureId,
    plan,
    title: featureTitle(projectRoot, config, plan.featureId),
  }));

  const regen = regeneratePageObjects({
    features,
    model: options.after,
    dialect: resolveDialect(config.dialect),
    existingPageObjects: records,
    logger,
  });

  const decisions = planWrites({ suiteRoot, files: regen.files, logger });
  const gate = runCompileGate({
    projectRoot,
    suiteRoot,
    decisions,
    existingFiles: discoverSuiteFiles(suiteRoot),
    logger,
  });

  if (!gate.ok) {
    // The specs are the check: they were not rewritten, so a failure here means
    // the tests genuinely no longer fit the app. Re-pointing cannot fix that.
    console.log('');
    console.log('Page objects were NOT written: the existing specs no longer compile');
    console.log('against the new Screen Model.');
    for (const line of gate.errors.slice(0, 15)) console.log(`  ${line}`);
    if (gate.errors.length > 15) console.log(`  … and ${gate.errors.length - 15} more`);
    if (regen.staleLocators.length > 0) {
      console.log('');
      console.log('Locators that could not be re-emitted — their elements are gone:');
      for (const stale of regen.staleLocators) {
        const owners = stale.features.length > 0 ? ` (used by ${stale.features.join(', ')})` : '';
        console.log(`  ${stale.className}: ${stale.elementIds.join(', ')}${owners}`);
      }
    }
    console.log('');
    console.log('This drift changed what the tests can do, not just where things are.');
    console.log('Re-plan instead:  flint ci');
    return false;
  }

  const applied = applyWrites(suiteRoot, decisions, logger);
  const liveElementIds = new Set(options.after.pages.flatMap((p) => p.elements.map((e) => e.id)));
  writePageObjectRecords(projectRoot, pruneToModel(regen.pageObjectRecords, liveElementIds));

  // The repair is only real once the model on disk is the one the page objects
  // were built from. Writing it here is what makes the next `--diff` clean.
  writeModel(options.modelFile, options.after);

  const rescanned = scanSuite({ projectRoot, suiteDir: config.suiteDir, logger });
  writeIndex(indexPath(projectRoot), rescanned.index);

  console.log('');
  console.log(
    applied.written === 0
      ? 'Page objects already matched the new model — nothing needed rewriting.'
      : `Re-pointed ${applied.written} page object file(s); specs untouched.`,
  );
  console.log('The existing specs still compile against them.');
  console.log(`Screen Model updated: ${options.modelFile}`);
  console.log('');
  console.log('Run `flint verify` to confirm they still pass.');
  return true;
}

/**
 * What to do about the drift. Which advice is right depends on the kind of
 * change, so this picks rather than listing every command Flint has.
 */
function printNextSteps(impact: DriftImpact): void {
  const breaking = breakingTests(impact).length;
  if (impact.affectedPageObjects.length === 0) {
    if (impact.newElements.length > 0) {
      console.log('');
      console.log('Next: write a feature spec covering the new elements, then `flint ci`.');
    }
    return;
  }

  console.log('');
  console.log('Next:');
  console.log('  flint explore --diff --fix-page-objects');
  console.log('      re-point the page objects at the new UI, keeping every spec as it is.');
  console.log('      Refuses if the specs no longer compile — that is drift a re-point');
  console.log('      cannot fix.');
  if (breaking > 0) {
    console.log('  flint ci');
    console.log('      re-plan and regenerate everything, if the feature itself changed.');
  }
}

/** The feature's human title, or its id when the spec has gone. */
function featureTitle(projectRoot: string, config: FlintConfig, featureId: string): string {
  try {
    return readFeatureSpec(projectRoot, config.kbDir, featureId).frontmatter.title;
  } catch {
    // A plan can outlive its spec. The title only names a `describe` block, and
    // page objects do not have one, so the fallback costs nothing here.
    return featureId;
  }
}
