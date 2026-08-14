import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Command } from 'commander';
import { loadConfig } from '../../config/load.js';
import { createLogger } from '../../shared/logger.js';
import { FlintError } from '../../shared/errors.js';
import { displayPath } from '../hints.js';
import { AnthropicProvider } from '../../llm/index.js';
import { modelPath, readModel } from '../../explorer/screen-model-store.js';
import { launchBrowser } from '../../explorer/browser.js';
import { createAuthenticatedContext } from '../../explorer/auth.js';
import { validateModel } from '../../explorer/validator.js';
import { scanSuite } from '../../indexer/scan.js';
import { listFeatureIds, readFeatureSpec } from '../../planner/feature-spec.js';
import { generatePlan } from '../../planner/planner.js';
import { ownedSpecFiles } from '../../planner/supersede.js';
import { hideSupersededTests } from '../../planner/hide-superseded.js';
import { sessionCoverage } from '../../planner/session-coverage.js';
import { planPath, writePlan } from '../../planner/store.js';
import type { TestPlan } from '../../schemas/test-plan.js';
import type { ExemplarFile } from '../../planner/context-builder.js';
import { emitBatch, type BatchFeature } from '../../generator/batch.js';
import { resolveDialect } from '../../generator/dialects/index.js';
import {
  pruneToModel,
  readPageObjectRecords,
  writePageObjectRecords,
} from '../../generator/page-object-store.js';
import { applyWrites, planWrites } from '../../integrator/writer.js';
import { runCompileGate } from '../../integrator/gate.js';
import { discoverSuiteFiles } from '../../integrator/suite-files.js';
import { divertDeadlockAdvice } from '../../integrator/divert-deadlock.js';
import { checkHealth } from '../../verifier/health.js';
import { runSuite } from '../../verifier/runner.js';
import { assembleRunReport, newRunId, passRate } from '../../verifier/report.js';
import { repairFailures, type RepairSummary } from '../../verifier/repair-runner.js';
import { RecordingProvider } from '../../bench/recorder.js';
import {
  assembleBench,
  formatBaseline,
  pct,
  provisionalReasons,
  type FeatureInput,
  type StageTiming,
} from '../../bench/metrics.js';

/**
 * `flint bench` — measure the pipeline, and write the number V2 must beat.
 *
 * The master plan makes a V1 baseline a prerequisite for V2: agentic upgrades
 * have to **prove** improvement rather than vibe it. That only works if the
 * baseline is recorded before anyone starts building the thing it judges, which
 * is why this ships in Phase 6 rather than "when we get to V2".
 *
 * It is deliberately not `flint ci --json`. `ci` reports what a run did; bench
 * reports what the pipeline *costs and achieves* — per-feature tokens and
 * dollars, wall time per stage, and the pass rate before repair as well as
 * after. That first-run number is the one `ci` cannot give you: `ci` repairs and
 * then reports, so the pre-repair rate is gone by the time it prints.
 *
 * Every metric is measured or explicitly absent. Nothing defaults to zero.
 */
export function registerBench(program: Command): void {
  program
    .command('bench')
    .description('Measure the pipeline end to end and record a baseline')
    .option('-d, --dir <dir>', 'project directory', '.')
    .option('--feature <id...>', 'only these features (default: every spec in kb/features)')
    .option('-o, --out <path>', 'where to write the baseline', 'benchmarks/baseline.md')
    .option('--validate', 'also re-resolve stored selectors (needs a browser)', false)
    .option('--no-repair', 'skip the repair pass; post-repair pass will read "not measured"')
    .option('--no-write', 'measure without writing the suite or the baseline')
    .option('--json', 'print the report as JSON', false)
    .option('-v, --verbose', 'verbose logging', false)
    .action(async (opts: BenchOptions) => {
      await runBench(opts);
    });
}

interface BenchOptions {
  dir: string;
  feature?: string[];
  out: string;
  validate: boolean;
  /** commander maps `--no-repair` onto this, defaulting to true. */
  repair: boolean;
  /** commander maps `--no-write` onto this, defaulting to true. */
  write: boolean;
  json: boolean;
  verbose: boolean;
}

async function runBench(opts: BenchOptions): Promise<void> {
  const projectRoot = resolve(process.cwd(), opts.dir);
  const logger = createLogger({ verbose: opts.verbose });
  const { config } = await loadConfig(projectRoot);
  const suiteRoot = resolve(projectRoot, config.suiteDir);
  const say = (line = ''): void => {
    if (!opts.json) console.log(line);
  };

  const modelFile = modelPath(projectRoot, undefined);
  if (!existsSync(modelFile)) {
    throw new FlintError('No Screen Model — nothing to benchmark against.', {
      code: 'BENCH',
      hint: 'Run `flint explore` first, then `flint bench`.',
    });
  }
  const model = readModel(modelFile);

  const featureIds = opts.feature ?? listFeatureIds(projectRoot, config.kbDir);
  if (featureIds.length === 0) {
    throw new FlintError('No feature specs to benchmark.', {
      code: 'BENCH',
      hint: `Write at least one spec under ${config.kbDir}/features/.`,
    });
  }

  const wallStart = Date.now();
  const stages: StageTiming[] = [];
  const stage = async <T>(name: string, run: () => Promise<T> | T): Promise<T> => {
    const start = Date.now();
    const result = await run();
    stages.push({ stage: name, ms: Date.now() - start });
    return result;
  };

  // The recording provider wraps the real one, so the measured path is the
  // production path rather than a copy that could drift from it.
  const provider = new RecordingProvider(
    new AnthropicProvider({ logger, logPrompts: config.debug.logPrompts }),
  );

  // ---- plan ---------------------------------------------------------------
  say('');
  say(`Benchmarking ${featureIds.length} feature(s): ${featureIds.join(', ')}`);

  const batchFeatures: BatchFeature[] = [];
  const perFeatureCalls = new Map<string, number>();
  // Held in memory and persisted only if the gate passes — same reason as `ci`:
  // a stored plan is a claim that its tests exist, and a benchmark run that
  // fails the gate writes no tests.
  const planned = new Map<string, TestPlan>();

  await stage('plan', async () => {
    for (const featureId of featureIds) {
      const mark = provider.mark();
      const spec = readFeatureSpec(projectRoot, config.kbDir, featureId);
      const scanned = scanSuite({
        projectRoot,
        suiteDir: config.suiteDir,
        logger,
        planHistory: sessionCoverage({
          projectRoot,
          runFeatures: featureIds,
          planned,
          excludeFeature: spec.frontmatter.id,
        }),
      }).index;
      const owned = ownedSpecFiles(scanned, spec.frontmatter.id);
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

      planned.set(spec.frontmatter.id, result.plan);
      batchFeatures.push({
        featureId: spec.frontmatter.id,
        plan: result.plan,
        title: spec.frontmatter.title,
      });
      perFeatureCalls.set(spec.frontmatter.id, mark);
      say(`  ${spec.frontmatter.id}: ${result.plan.cases.length} case(s)`);
    }
  });

  // ---- emit + gate --------------------------------------------------------
  const batch = await stage('emit', () =>
    emitBatch({
      features: batchFeatures,
      model,
      dialect: resolveDialect(config.dialect),
      existingPageObjects: readPageObjectRecords(projectRoot),
      logger,
    }),
  );

  const decisions = planWrites({ suiteRoot, files: batch.files, logger });
  const gate = await stage('compile-gate', () =>
    runCompileGate({
      projectRoot,
      suiteRoot,
      decisions,
      existingFiles: discoverSuiteFiles(suiteRoot),
      logger,
    }),
  );

  // Attribute gate errors to features by the spec file they name, so the
  // compile rate is per-feature rather than one all-or-nothing boolean.
  const failedFeatures = attributeGateErrors(gate.errors, batchFeatures);

  if (gate.ok && opts.write) {
    applyWrites(suiteRoot, decisions, logger);
    const liveElementIds = new Set(model.pages.flatMap((p) => p.elements.map((e) => e.id)));
    writePageObjectRecords(projectRoot, pruneToModel(batch.pageObjectRecords, liveElementIds));
    for (const [id, plan] of planned) writePlan(planPath(projectRoot, id), plan);
  }

  if (!gate.ok) {
    say('');
    say('The generated suite does not typecheck, so nothing was written:');
    for (const line of gate.errors.slice(0, 10)) say(`  ${line}`);
    if (gate.errors.length > 10) say(`  … and ${gate.errors.length - 10} more`);
    for (const line of divertDeadlockAdvice({
      decisions,
      errors: gate.errors,
      suiteDir: config.suiteDir,
    })) {
      say(line);
    }
  }

  // ---- verify: first run, then repair ------------------------------------
  let firstRunPass: number | undefined;
  let postRepairPass: number | undefined;

  const health = await checkHealth({ baseUrl: config.baseUrl, logger });
  if (!health.healthy) {
    say('');
    say(`The application is not reachable: ${health.detail}`);
    say('Pass rates will read "not measured" — nothing here is a test defect.');
  } else if (gate.ok) {
    const startedAt = new Date();
    const outcome = await stage('verify', () =>
      runSuite({ suiteRoot, logger, env: { BASE_URL: config.baseUrl } }),
    );
    if (outcome.ran) {
      firstRunPass = passRate(
        assembleRunReport({
          runId: newRunId(startedAt),
          startedAt: startedAt.toISOString(),
          finishedAt: new Date().toISOString(),
          baseUrl: config.baseUrl,
          health,
          outcome,
        }).summary,
      );

      if (opts.repair) {
        const repairs: RepairSummary[] = [];
        const flaky: string[] = [];
        const repaired = await stage('repair', () =>
          repairFailures({
            projectRoot,
            suiteRoot,
            outcome,
            role: undefined,
            logger,
            repairs,
            flaky,
            llm: {
              provider,
              modelId: config.models.repair,
              tokenBudget: config.tokenBudgets.repair,
            },
          }),
        );
        postRepairPass = passRate(
          assembleRunReport({
            runId: newRunId(startedAt),
            startedAt: startedAt.toISOString(),
            finishedAt: new Date().toISOString(),
            baseUrl: config.baseUrl,
            health,
            outcome: repaired,
          }).summary,
        );
      }
    }
  }

  // ---- selector re-resolve rate (opt-in; needs a browser) -----------------
  let selectorResolveRate: number | undefined;
  if (opts.validate) {
    selectorResolveRate = await stage('validate', () =>
      measureResolveRate(projectRoot, config, logger),
    );
  }

  // ---- assemble ----------------------------------------------------------
  const features: FeatureInput[] = batchFeatures.map((feature) => {
    const emitted = batch.perFeature.find((f) => f.featureId === feature.featureId);
    const mark = perFeatureCalls.get(feature.featureId) ?? 0;
    const nextMark = nextMarkAfter(perFeatureCalls, mark, provider.calls.length);
    return {
      featureId: feature.featureId,
      cases: feature.plan.cases.length,
      liveTests: emitted?.liveTests ?? 0,
      degraded: emitted?.degraded.length ?? 0,
      compiled: !failedFeatures.has(feature.featureId),
      calls: provider.calls.slice(mark, nextMark),
    };
  });

  const report = assembleBench({
    baseUrl: config.baseUrl,
    features,
    stages,
    wallMs: Date.now() - wallStart,
    ...(firstRunPass !== undefined ? { firstRunPass } : {}),
    ...(postRepairPass !== undefined ? { postRepairPass } : {}),
    ...(selectorResolveRate !== undefined ? { selectorResolveRate } : {}),
  });

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    say('');
    say(`Compile rate              ${pct(report.compileRate)}`);
    say(`First-run pass            ${pct(report.firstRunPass)}`);
    say(`Post-repair pass          ${pct(report.postRepairPass)}`);
    say(`Selector re-resolve rate  ${pct(report.selectorResolveRate)}`);
  }

  const provisional = provisionalReasons(report);

  if (opts.write) {
    const out = resolve(projectRoot, opts.out);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${formatBaseline(report)}\n`, 'utf8');
    writeFileSync(out.replace(/\.md$/, '.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    say('');
    say(`Baseline written to ${displayPath(out)}`);
    // The file says so too, at the top. Saying it here as well is what stops a
    // failed run from being committed as "the baseline" by someone who only
    // read the terminal.
    if (provisional.length > 0) {
      say('');
      say('⚠️  This is NOT a usable baseline — the run did not complete cleanly:');
      for (const reason of provisional) say(`      ${reason}`);
      say('    The file is marked provisional. Fix the run and re-run `flint bench`.');
    }
  }

  // A benchmark that could not measure the thing being benchmarked is not a
  // pass, even though nothing errored.
  if (!gate.ok || report.firstRunPass === undefined) process.exitCode = 1;
}

/**
 * Which features a gate failure belongs to.
 *
 * tsc names the file; the emitter names spec files after the feature. A page
 * object serves several features, so an error there is charged to none of them
 * individually — it goes to every feature in the batch, which is the honest
 * reading: the batch did not compile.
 */
function attributeGateErrors(errors: string[], features: BatchFeature[]): Set<string> {
  const failed = new Set<string>();
  if (errors.length === 0) return failed;

  let sawUnattributable = false;
  for (const error of errors) {
    const file = error.split('(')[0] ?? '';
    const owner = features.find((f) => file.includes(`/${f.featureId}.spec.`));
    if (owner === undefined) sawUnattributable = true;
    else failed.add(owner.featureId);
  }
  if (sawUnattributable) for (const feature of features) failed.add(feature.featureId);
  return failed;
}

/** The call index where the next feature's calls begin. */
function nextMarkAfter(marks: Map<string, number>, mark: number, total: number): number {
  const later = [...marks.values()].filter((m) => m > mark).sort((a, b) => a - b);
  return later[0] ?? total;
}

/**
 * Re-resolve every stored top selector against the live app.
 *
 * Opt-in because it needs a browser, credentials, and a minute — and because a
 * benchmark that silently launches Chromium is a surprise. Skipped, the metric
 * reads `not measured` rather than a fabricated 100%.
 */
async function measureResolveRate(
  projectRoot: string,
  config: Awaited<ReturnType<typeof loadConfig>>['config'],
  logger: ReturnType<typeof createLogger>,
): Promise<number | undefined> {
  const browser = await launchBrowser({ headed: false });
  try {
    const { context } = await createAuthenticatedContext(browser, { config, projectRoot, logger });
    const stored = readModel(modelPath(projectRoot, undefined));
    const report = await validateModel(context, stored, { logger });
    // "100% of nothing" is not a measurement.
    return report.selectorsChecked === 0 ? undefined : report.resolveRate;
  } finally {
    await browser.close().catch(() => undefined);
  }
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
