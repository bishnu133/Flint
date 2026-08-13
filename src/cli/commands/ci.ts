import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { loadConfig } from '../../config/load.js';
import type { FlintConfig } from '../../schemas/config.js';
import { createLogger, type Logger } from '../../shared/logger.js';
import { FlintError } from '../../shared/errors.js';
import { displayPath } from '../hints.js';
import { AnthropicProvider } from '../../llm/index.js';
import { modelPath, readModel } from '../../explorer/screen-model-store.js';
import { scanSuite } from '../../indexer/scan.js';
import { indexPath, writeIndex } from '../../indexer/store.js';
import { listFeatureIds, readFeatureSpec } from '../../planner/feature-spec.js';
import { generatePlan } from '../../planner/planner.js';
import { ownedSpecFiles } from '../../planner/supersede.js';
import { hideSupersededTests } from '../../planner/hide-superseded.js';
import { planHistoryCoverage, planPath, writePlan } from '../../planner/store.js';
import type { ExemplarFile } from '../../planner/context-builder.js';
import { emitBatch, type BatchFeature } from '../../generator/batch.js';
import { resolveDialect } from '../../generator/dialects/index.js';
import { pruneToModel, writePageObjectRecords } from '../../generator/page-object-store.js';
import { readPageObjectRecords } from '../../generator/page-object-store.js';
import { applyWrites, planWrites } from '../../integrator/writer.js';
import { runCompileGate } from '../../integrator/gate.js';
import { discoverSuiteFiles } from '../../integrator/suite-files.js';
import { emptiedSpecs, ownedByRun, testsInOwnedSpecs } from '../../integrator/shrink-guard.js';
import { checkHealth } from '../../verifier/health.js';
import { runSuite } from '../../verifier/runner.js';
import {
  assembleRunReport,
  formatRunSummary,
  newRunId,
  passRate,
  reportPath,
  writeRunReport,
} from '../../verifier/report.js';
import { repairFailures, type RepairSummary } from '../../verifier/repair-runner.js';

/**
 * `flint ci` — the whole pipeline, headless, in one command.
 *
 * Not just a shell loop over the other commands. Running them in sequence is
 * what the operator did, twice, and it failed both times:
 *
 *   plan cart; generate cart  -> compile gate fails on login.spec.ts, a file
 *                                that run never touched
 *
 * `flint generate <feature>` gates one feature against the suite as it stands,
 * which is right for one feature and wrong for a full run: whichever feature
 * goes first meets the others' un-regenerated specs. There is no safe order.
 *
 * So `ci` plans every feature, emits them **as one batch**, gates the combined
 * result once, and only then writes. The unit that must compile is the suite
 * afterwards. Nothing is written unless the whole thing typechecks, which keeps
 * the Phase 4 guarantee across a multi-feature run instead of only within one.
 *
 * Exploration is not run here. It needs a browser, credentials and minutes, and
 * a CI job that silently re-crawls a live application on every push is a
 * surprise nobody asked for. Run `flint explore` deliberately; `ci` uses the
 * Screen Model it finds and says so if there is none.
 */
export function registerCi(program: Command): void {
  program
    .command('ci')
    .description('Run the full pipeline headless: index → plan → generate → verify')
    .option('-d, --dir <dir>', 'project directory', '.')
    .option('--feature <id...>', 'only these features (default: every spec in kb/features)')
    .option('--repair', 'attempt to repair failing tests', false)
    .option('--no-llm', 'repair with verified selectors only — never call a model')
    .option('--ready', 'skip tests tagged @needs-setup when verifying', false)
    .option('--no-verify', 'stop after generating; do not run the suite')
    .option('--json', 'print a machine-readable summary instead of prose', false)
    .option('--allow-empty', 'write even if a spec that has tests would be left with none', false)
    .option('-v, --verbose', 'verbose logging', false)
    .action(async (opts: CiOptions) => {
      await runCi(opts);
    });
}

interface CiOptions {
  dir: string;
  feature?: string[];
  repair: boolean;
  /** commander maps `--no-llm` onto this, defaulting to true. */
  llm: boolean;
  ready: boolean;
  /** commander maps `--no-verify` onto this, defaulting to true. */
  verify: boolean;
  allowEmpty: boolean;
  json: boolean;
  verbose: boolean;
}

/** The machine-readable summary. Stable shape — CI parses this. */
interface CiSummary {
  ok: boolean;
  /** Where it stopped, when it stopped early. */
  failedStage?: 'model' | 'plan' | 'gate' | 'shrink' | 'verify';
  features: Array<{
    featureId: string;
    cases: number;
    liveTests: number;
    degraded: number;
    skippedDuplicates: number;
  }>;
  filesWritten: number;
  gate: { ran: boolean; ok: boolean; errors: number };
  /**
   * Tests in the spec files this run owns, before and after.
   *
   * Informational: a smaller plan is ordinary. What blocks the run is a spec
   * going to zero — see `emptiedSpecs`.
   */
  tests: { before: number; after: number };
  /** Features whose spec would have been erased. Non-empty means nothing was written. */
  emptiedSpecs?: string[];
  verify?: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    flaky: number;
    fixme: number;
    passRate: number | null;
    repaired: number;
  };
  reportPath?: string;
}

async function runCi(opts: CiOptions): Promise<void> {
  const projectRoot = resolve(process.cwd(), opts.dir);
  const logger = createLogger({ verbose: opts.verbose });
  const { config } = await loadConfig(projectRoot);
  const suiteRoot = resolve(projectRoot, config.suiteDir);
  const say = (line = ''): void => {
    if (!opts.json) console.log(line);
  };

  const modelFile = modelPath(projectRoot, undefined);
  if (!existsSync(modelFile)) {
    throw new FlintError('No Screen Model — nothing to plan against.', {
      code: 'CI',
      hint:
        `Run \`flint explore\` first. \`ci\` deliberately does not crawl: exploration ` +
        `needs a browser and credentials, and re-crawling a live application on every ` +
        `push is a surprise nobody asked for.`,
    });
  }
  const model = readModel(modelFile);

  const featureIds = opts.feature ?? listFeatureIds(projectRoot, config.kbDir);
  if (featureIds.length === 0) {
    throw new FlintError('No feature specs to run.', {
      code: 'CI',
      hint: `Write at least one spec under ${config.kbDir}/features/.`,
    });
  }

  // ---- plan every feature ------------------------------------------------
  const provider = new AnthropicProvider({ logger, logPrompts: config.debug.logPrompts });
  const batchFeatures: BatchFeature[] = [];

  say('');
  say(`Planning ${featureIds.length} feature(s): ${featureIds.join(', ')}`);

  // The tests in the spec files this run owns, before it touches anything.
  // The guard below compares against it.
  const baseline = scanSuite({ projectRoot, suiteDir: config.suiteDir, logger }).index;
  const testsBefore = testsInOwnedSpecs(baseline, ownedByRun(baseline, featureIds));

  for (const featureId of featureIds) {
    const spec = readFeatureSpec(projectRoot, config.kbDir, featureId);
    const scanned = scanSuite({
      projectRoot,
      suiteDir: config.suiteDir,
      logger,
      planHistory: planHistoryCoverage(projectRoot, { excludeFeature: spec.frontmatter.id }),
    }).index;
    const owned = ownedSpecFiles(scanned, spec.frontmatter.id);
    // Hides the feature's own generated tests from BOTH places the planner sees
    // them — the coverage map and the plain list of existing test titles. The
    // second was the gap that let a run mark a whole plan duplicate and empty
    // the spec it was regenerating.
    const index = hideSupersededTests(scanned, spec.frontmatter.id);

    const result = await generatePlan({
      spec,
      model,
      provider,
      modelId: config.models.planner,
      tokenBudget: config.tokenBudgets.plan,
      logger,
      index,
      exemplars: readExemplars(projectRoot, index, owned),
      ...(readConventions(projectRoot, config.kbDir) !== undefined
        ? { conventions: readConventions(projectRoot, config.kbDir)! }
        : {}),
    });

    writePlan(planPath(projectRoot, spec.frontmatter.id), result.plan);
    batchFeatures.push({
      featureId: spec.frontmatter.id,
      plan: result.plan,
      title: spec.frontmatter.title,
    });
    say(`  ${spec.frontmatter.id}: ${result.plan.cases.length} case(s)`);
  }

  // ---- emit them as one batch, gate once ---------------------------------
  const storedPageObjects = readPageObjectRecords(projectRoot);
  const batch = emitBatch({
    features: batchFeatures,
    model,
    dialect: resolveDialect(config.dialect),
    existingPageObjects: storedPageObjects,
    logger,
  });

  const decisions = planWrites({ suiteRoot, files: batch.files, logger });
  const gate = runCompileGate({
    projectRoot,
    suiteRoot,
    decisions,
    existingFiles: discoverSuiteFiles(suiteRoot),
    logger,
  });

  const summary: CiSummary = {
    ok: false,
    features: batch.perFeature.map((f) => {
      const plan = batchFeatures.find((b) => b.featureId === f.featureId)!.plan;
      return {
        featureId: f.featureId,
        cases: plan.cases.length,
        liveTests: f.liveTests,
        degraded: f.degraded.length,
        skippedDuplicates: f.skippedDuplicates.length,
      };
    }),
    filesWritten: 0,
    gate: { ran: gate.ran, ok: gate.ok, errors: gate.errors.length },
    tests: { before: testsBefore, after: testsAfter(batch) },
  };

  // ---- refuse to erase a spec --------------------------------------------
  // A planner that marked every case a duplicate took a 13-test suite down to 3
  // and the run reported "CI passed." The compile gate cannot catch that — an
  // empty spec typechecks perfectly — so this counts tests instead.
  //
  // The line is zero, not "fewer": planning is a model call, and a case merging
  // into another between runs is ordinary. Blocking on that would just teach
  // everyone to pass the override.
  const erased = emptiedSpecs({
    baseline,
    emitted: batch.perFeature.map((f) => ({
      featureId: f.featureId,
      tests: f.liveTests + f.degraded.length,
    })),
  });
  summary.emptiedSpecs = erased.map((e) => e.featureId);

  if (!opts.allowEmpty && erased.length > 0) {
    say('');
    say('Refusing to write: this run would erase spec files that currently have tests.');
    for (const spec of erased) {
      say(`  ${spec.featureId}: ${spec.files.join(', ')} — ${spec.tests} test(s) would be lost`);
    }
    say('');
    say('Nothing was written.');
    if (batch.fullyDuplicated.length > 0) {
      say('');
      say(`Every case came back a duplicate for: ${batch.fullyDuplicated.join(', ')}.`);
      say('Usually that means the planner was shown the very tests it was regenerating.');
    }
    say('');
    say('Check the plans under .flint/plans, then either fix the feature spec or');
    say('re-run with --allow-empty if those tests really should go.');
    summary.failedStage = 'shrink';
    finish(summary, opts, say);
    return;
  }

  // Not a refusal, but worth a sentence: nothing here is lost silently.
  if (summary.tests.after < summary.tests.before) {
    say('');
    say(
      `Note: this run writes ${summary.tests.after} test(s) where the suite had ` +
        `${summary.tests.before}. No spec was erased; the plan is simply smaller.`,
    );
  }

  if (!gate.ok) {
    // The whole batch is rejected together — the suite is untouched.
    say('');
    say('The generated suite does not typecheck; nothing was written:');
    for (const line of gate.errors.slice(0, 20)) say(`  ${line}`);
    if (gate.errors.length > 20) say(`  … and ${gate.errors.length - 20} more`);
    summary.failedStage = 'gate';
    finish(summary, opts, say);
    return;
  }

  const applied = applyWrites(suiteRoot, decisions, logger);
  const liveElementIds = new Set(model.pages.flatMap((p) => p.elements.map((e) => e.id)));
  writePageObjectRecords(projectRoot, pruneToModel(batch.pageObjectRecords, liveElementIds));
  summary.filesWritten = applied.written;

  say('');
  say(
    applied.written === 0
      ? 'Suite already up to date — regenerating produced identical files.'
      : `Wrote ${applied.written} file(s) to ${config.suiteDir}`,
  );
  if (!gate.ran) {
    say(`NOTE: the compile gate did not run (${gate.skippedReason ?? 'no reason given'}).`);
  }

  // Re-index so the stored index matches what was just written.
  const rescanned = scanSuite({ projectRoot, suiteDir: config.suiteDir, logger });
  writeIndex(indexPath(projectRoot), rescanned.index);

  if (batch.fullyDuplicated.length > 0) {
    say('');
    say(`No new tests for: ${batch.fullyDuplicated.join(', ')} — every case was a duplicate.`);
    say('That is expected when another feature already covers the same ground.');
  }

  if (!opts.verify) {
    summary.ok = true;
    finish(summary, opts, say);
    return;
  }

  // ---- verify ------------------------------------------------------------
  const startedAt = new Date();
  const health = await checkHealth({ baseUrl: config.baseUrl, logger });
  const outcome = runSuite({
    suiteRoot,
    logger,
    env: { BASE_URL: config.baseUrl },
    ...(opts.ready ? { grepInvert: '@needs-setup' } : {}),
  });

  if (!outcome.ran) {
    say('');
    say(`The suite was not run: ${outcome.notRunReason ?? 'no reason given'}`);
    summary.failedStage = 'verify';
    finish(summary, opts, say);
    return;
  }

  const repairs: RepairSummary[] = [];
  const flaky: string[] = [];
  const finalOutcome =
    opts.repair && health.healthy
      ? await repairFailures({
          projectRoot,
          suiteRoot,
          outcome,
          role: undefined,
          logger,
          repairs,
          flaky,
          ...(opts.llm ? { llm: repairModel(config, logger) } : {}),
        })
      : outcome;

  const report = assembleRunReport({
    runId: newRunId(startedAt),
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    baseUrl: config.baseUrl,
    health,
    outcome: finalOutcome,
  });
  const path = reportPath(projectRoot, report.runId);
  writeRunReport(path, report);

  say('');
  say(formatRunSummary(report));
  if (repairs.length > 0) {
    say('');
    say('Repairs:');
    for (const r of repairs) {
      say(`  ${r.repaired ? '✓' : '✗'} ${r.title}`);
      for (const line of r.detail) say(`      ${line}`);
    }
  }
  say('');
  say(`Report written to   ${displayPath(path)}`);

  const rate = passRate(report.summary);
  summary.verify = {
    total: report.summary.total,
    passed: report.summary.passed,
    failed: report.summary.failed,
    skipped: report.summary.skipped,
    flaky: report.summary.flaky,
    fixme: report.summary.fixme,
    passRate: rate ?? null,
    repaired: repairs.filter((r) => r.repaired).length,
  };
  summary.reportPath = path;
  summary.ok = report.envHealthy && report.summary.failed === 0 && rate !== undefined;
  if (!summary.ok) summary.failedStage = 'verify';
  finish(summary, opts, say);
}

/**
 * Print the summary and set the exit code.
 *
 * Non-zero on anything that is not a clean pass, because a CI step that exits 0
 * on a failed gate is worse than no CI step at all.
 */
function finish(summary: CiSummary, opts: CiOptions, say: (line?: string) => void): void {
  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    say('');
    say(summary.ok ? 'CI passed.' : `CI failed at the ${summary.failedStage ?? 'unknown'} stage.`);
  }
  if (!summary.ok) process.exitCode = 1;
}

/** Tests this batch will have written: live ones plus the degraded placeholders. */
function testsAfter(batch: {
  perFeature: Array<{ liveTests: number; degraded: unknown[] }>;
}): number {
  return batch.perFeature.reduce((sum, f) => sum + f.liveTests + f.degraded.length, 0);
}

function repairModel(
  config: FlintConfig,
  logger: Logger,
): { provider: AnthropicProvider; modelId: string; tokenBudget: number } {
  return {
    provider: new AnthropicProvider({ logger, logPrompts: config.debug.logPrompts }),
    modelId: config.models.repair,
    tokenBudget: config.tokenBudgets.repair,
  };
}

function readConventions(projectRoot: string, kbDir: string): string | undefined {
  const path = resolve(projectRoot, kbDir, 'conventions.md');
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

/** Same rule as `flint plan`: never a file the feature being planned owns. */
function readExemplars(
  projectRoot: string,
  index: { specs: Array<{ file: string }> },
  owned: ReadonlySet<string>,
): ExemplarFile[] {
  const exemplars: ExemplarFile[] = [];
  for (const spec of index.specs) {
    if (exemplars.length === 2) break;
    if (owned.has(spec.file)) continue;
    const path = resolve(projectRoot, spec.file);
    if (!existsSync(path)) continue;
    exemplars.push({ path: spec.file, contents: readFileSync(path, 'utf8') });
  }
  return exemplars;
}
