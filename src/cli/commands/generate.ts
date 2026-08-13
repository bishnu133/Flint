import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { Command } from 'commander';
import { loadConfig } from '../../config/load.js';
import { createLogger } from '../../shared/logger.js';
import { FlintError } from '../../shared/errors.js';
import { dirSuffix } from '../hints.js';
import { modelPath, readModel } from '../../explorer/screen-model-store.js';
import { readFeatureSpec, listFeatureIds } from '../../planner/feature-spec.js';
import { planPath, readPlan } from '../../planner/store.js';
import { emitFeature, type StaleLocators } from '../../generator/emitter.js';
import { resolveDialect } from '../../generator/dialects/index.js';
import {
  mergePageObjectRecords,
  pruneToModel,
  readPageObjectRecords,
  writePageObjectRecords,
} from '../../generator/page-object-store.js';
import { applyWrites, formatWritePlan, planWrites } from '../../integrator/writer.js';
import { runCompileGate } from '../../integrator/gate.js';
import { discoverSuiteFiles } from '../../integrator/suite-files.js';

/**
 * `flint generate <feature>` — Stage B.
 *
 * Reads the TestPlan Phase 3 wrote and the Screen Model Phase 1 captured, emits
 * TypeScript, typechecks it, and only then writes into the suite. Nothing here
 * calls a model: the plan is already a complete instruction set.
 */
export function registerGenerate(program: Command): void {
  program
    .command('generate')
    .description('Emit Playwright TypeScript from a TestPlan (Stage B)')
    .argument('[feature]', 'feature id with a plan under .flint/plans/')
    .option('-d, --dir <dir>', 'project directory', '.')
    .option('--role <role>', 'use the Screen Model captured for a named role')
    .option('--dry-run', 'show what would be written and exit', false)
    .option('--no-gate', 'skip the typecheck before writing')
    .option('-v, --verbose', 'verbose logging', false)
    .action(async (feature: string | undefined, opts: GenerateOptions) => {
      await runGenerate(feature, opts);
    });
}

interface GenerateOptions {
  dir: string;
  role?: string;
  dryRun: boolean;
  /** commander maps `--no-gate` onto this, defaulting to true. */
  gate: boolean;
  verbose: boolean;
}

async function runGenerate(feature: string | undefined, opts: GenerateOptions): Promise<void> {
  const projectRoot = resolve(process.cwd(), opts.dir);
  const logger = createLogger({ verbose: opts.verbose });
  const { config } = await loadConfig(projectRoot);

  if (feature === undefined || feature === '') {
    const available = listFeatureIds(projectRoot, config.kbDir);
    throw new FlintError('No feature id given.', {
      code: 'CLI',
      hint:
        available.length === 0
          ? `Write a spec under ${join(config.kbDir, 'features')}, then run \`flint plan <feature>\`.`
          : // See the note in plan.ts — a runnable line, not just a grammar.
            `Usage: flint generate <feature>. Available: ${available.join(', ')}\n` +
            `      Try: flint generate ${available[0]}${dirSuffix(opts.dir)}`,
    });
  }

  const spec = readFeatureSpec(projectRoot, config.kbDir, feature);
  const featureId = spec.frontmatter.id;

  const jsonPath = planPath(projectRoot, featureId);
  if (!existsSync(jsonPath)) {
    throw new FlintError(`No TestPlan for "${featureId}".`, {
      code: 'CLI',
      hint: `Run \`flint plan ${featureId}\` first.`,
    });
  }
  const plan = readPlan(jsonPath);
  const model = readModel(modelPath(projectRoot, opts.role));

  if (plan.screenModelVersion !== model.version) {
    // Not fatal: element ids are content-derived, so a plan usually survives a
    // re-crawl. But a mismatch is exactly when a stale elementRef appears, and
    // the emitter degrades those to test.fixme rather than guessing.
    logger.warn(
      { planVersion: plan.screenModelVersion, modelVersion: model.version },
      'generate: the plan was made against a different Screen Model version',
    );
  }

  const dialect = resolveDialect(config.dialect);
  // What earlier features already put on these pages. Without it, generating a
  // second feature that touches the same page would emit a page object holding
  // only its own locators and break the first feature's spec.
  const storedPageObjects = readPageObjectRecords(projectRoot);
  const result = emitFeature({
    plan,
    model,
    dialect,
    title: spec.frontmatter.title,
    existingPageObjects: storedPageObjects,
    logger,
  });

  const suiteRoot = resolve(projectRoot, config.suiteDir);
  const decisions = planWrites({ suiteRoot, files: result.files, logger });

  console.log('');
  console.log(`Feature:          ${featureId}`);
  console.log(`Page objects:     ${result.pageObjects.join(', ') || '(none)'}`);
  console.log(`Tests:            ${plan.cases.length - result.skippedDuplicates.length}`);
  if (result.degraded.length > 0) {
    console.log(`  needs work      ${result.degraded.length}`);
  }
  if (result.skippedDuplicates.length > 0) {
    console.log(`Skipped (dupes):  ${result.skippedDuplicates.length}`);
  }

  console.log('');
  console.log(formatWritePlan(decisions, config.suiteDir));

  const emitted = plan.cases.length - result.skippedDuplicates.length;

  // A plan whose every case is a duplicate emits an empty spec — and `update`
  // on an existing file means those tests are about to be deleted. That is the
  // exact shape of the most damaging bug in this project's history, so it is
  // refused rather than warned about: nothing is written, and the operator is
  // told how to get their coverage back.
  const specPaths = new Set(result.files.filter((f) => f.kind === 'spec').map((f) => f.path));
  const emptying =
    emitted === 0
      ? decisions.find((d) => specPaths.has(d.path) && d.outcome === 'updated')
      : undefined;
  if (emptying !== undefined) {
    console.log('');
    console.log(`REFUSING TO WRITE: every case in this plan is a duplicate, so`);
    console.log(`${emptying.path} would be rewritten with no tests in it.`);
    console.log('');
    console.log('The tests that file already holds would be lost. Either:');
    console.log(`  - re-run \`flint plan ${featureId}${dirSuffix(opts.dir)}\` — a re-plan`);
    console.log("    supersedes this feature's own previous tests rather than deferring to them;");
    console.log('  - or, if another feature genuinely covers this ground now, delete');
    console.log(`    ${emptying.path} deliberately.`);
    throw new FlintError('The plan would empty an existing spec file.', {
      code: 'GENERATE',
      hint: `Nothing was written. ${featureId} currently has ${plan.cases.length} case(s), all marked skipped-duplicate.`,
    });
  }
  if (result.degraded.length > 0) {
    console.log('');
    console.log('Not runnable as generated:');
    for (const item of result.degraded) {
      console.log(`  ${item.mode === 'fixme' ? '!' : '~'} ${item.title}`);
      console.log(`      ${item.reason}`);
    }
  }

  // A suite where nothing runs looks like success — green output, files
  // written, a clean typecheck — while proving nothing at all. Say so.
  if (emitted > 0 && result.degraded.length === emitted) {
    const setupOnly = result.degraded.filter((d) => d.mode === 'skip').length;
    console.log('');
    console.log(`WARNING: none of the ${emitted} test(s) will run.`);
    if (setupOnly > 0) {
      console.log(`  ${setupOnly} are skipped only for setup. If a prerequisite above is already`);
      console.log('  satisfied, remove it from the plan and re-run `flint generate`.');
    }
    process.exitCode = 1;
  }

  const gate = runCompileGate({
    projectRoot,
    suiteRoot,
    decisions,
    existingFiles: discoverSuiteFiles(suiteRoot),
    logger,
    skip: !opts.gate,
  });

  if (!gate.ok) {
    // The suite is untouched — that is the point of gating before writing.
    console.log('');
    console.log('Generated code does not typecheck; nothing was written:');
    for (const line of gate.errors.slice(0, 20)) console.log(`  ${line}`);
    if (gate.errors.length > 20) console.log(`  … and ${gate.errors.length - 20} more`);

    // The common cause is not a bug in the emitter: the Screen Model changed
    // under page objects an earlier feature generated, so that feature's spec
    // still names locators this run removes. Flint knows exactly which features
    // those are — saying "report a bug" when it can name the fix is a failure
    // to use what it already worked out.
    const stalled = staleFeatures(result.staleLocators);
    if (stalled.length > 0) {
      console.log('');
      console.log('This is a stale-suite failure, not a defect in the generated code.');
      console.log('The Screen Model has changed since these page objects were written, so');
      console.log('locators they used no longer exist:');
      for (const stale of result.staleLocators) {
        console.log(`  ${stale.className}: ${stale.elementIds.length} locator(s) dropped`);
      }
      console.log('');
      console.log(`The errors above are in ${stalled.join(', ')} — feature(s) this run did not`);
      console.log('regenerate. Re-plan and re-generate them first, then this one:');
      console.log('');
      for (const feature of stalled) {
        console.log(`  flint plan ${feature}${dirSuffix(opts.dir)}`);
        console.log(`  flint generate ${feature}${dirSuffix(opts.dir)}`);
      }
      console.log(`  flint generate ${featureId}${dirSuffix(opts.dir)}`);
    }

    throw new FlintError('The generated suite failed the compile gate.', {
      code: 'GENERATE',
      hint:
        stalled.length > 0
          ? `Regenerate ${stalled.join(', ')} first — see the commands above. Nothing was written.`
          : 'This is a Flint bug — please report the feature id and the errors above. Re-run with --no-gate to write anyway.',
    });
  }

  if (opts.dryRun) {
    console.log('');
    console.log('Dry run — nothing written.');
    return;
  }

  const applied = applyWrites(suiteRoot, decisions, logger);
  // Written only after the files land, so a failed run cannot leave the record
  // claiming locators that were never emitted.
  // Pruned only here, after the write succeeded and the gate passed: at this
  // point nothing in the suite still references an element the model dropped,
  // so carrying dead ids forward only produces a permanent false alarm.
  const liveElementIds = new Set(model.pages.flatMap((p) => p.elements.map((e) => e.id)));
  writePageObjectRecords(
    projectRoot,
    pruneToModel(
      mergePageObjectRecords(storedPageObjects, result.pageObjectRecords),
      liveElementIds,
    ),
  );

  console.log('');
  console.log(
    applied.written === 0
      ? 'Already up to date — regenerating produced identical files.'
      : `Wrote ${applied.written} file(s) to ${relative(projectRoot, suiteRoot) || '.'}`,
  );

  if (applied.diverted.length > 0) {
    console.log('');
    console.log('Your edits were kept. Flint wrote its version beside them:');
    for (const item of applied.diverted) {
      console.log(`  ${join(config.suiteDir, item.targetPath)}  (${item.reason})`);
    }
    console.log('  Merge what you want and delete the sibling file.');
    process.exitCode = 1;
  }

  if (gate.ran) {
    console.log('');
    console.log('Typechecked clean before writing.');
  } else if (gate.skippedReason !== undefined) {
    console.log('');
    console.log(`NOTE: compile gate skipped — ${gate.skippedReason}.`);
  }
}

/**
 * Features whose specs still reference locators this run drops.
 *
 * These are the ones that must be re-planned and re-generated first: their
 * plans reference the old element ids too, so regenerating without re-planning
 * would just fail the referential validator instead.
 */
function staleFeatures(stale: readonly StaleLocators[]): string[] {
  return [...new Set(stale.flatMap((s) => s.features))].sort();
}
