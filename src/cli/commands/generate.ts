import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { Command } from 'commander';
import { loadConfig } from '../../config/load.js';
import { createLogger } from '../../shared/logger.js';
import { FlintError } from '../../shared/errors.js';
import { modelPath, readModel } from '../../explorer/screen-model-store.js';
import { readFeatureSpec, listFeatureIds } from '../../planner/feature-spec.js';
import { planPath, readPlan } from '../../planner/store.js';
import { emitFeature } from '../../generator/emitter.js';
import { resolveDialect } from '../../generator/dialects/index.js';
import {
  mergePageObjectRecords,
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
          : `Usage: flint generate <feature>. Available: ${available.join(', ')}`,
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

  if (result.degraded.length > 0) {
    console.log('');
    console.log('Not runnable as generated:');
    for (const item of result.degraded) {
      console.log(`  ${item.mode === 'fixme' ? '!' : '~'} ${item.title}`);
      console.log(`      ${item.reason}`);
    }
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
    throw new FlintError('The generated suite failed the compile gate.', {
      code: 'GENERATE',
      hint: 'This is a Flint bug — please report the feature id and the errors above. Re-run with --no-gate to write anyway.',
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
  writePageObjectRecords(
    projectRoot,
    mergePageObjectRecords(storedPageObjects, result.pageObjectRecords),
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
