import { relative, resolve } from 'node:path';
import type { Command } from 'commander';
import { loadConfig } from '../../config/load.js';
import type { FlintConfig } from '../../schemas/config.js';
import { AnthropicProvider } from '../../llm/index.js';
import { createLogger, type Logger } from '../../shared/logger.js';
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
import { mayBeAppDefect } from '../../verifier/classifier.js';
import { repairFailures, type RepairSummary } from '../../verifier/repair-runner.js';

/**
 * `flint verify` — run the generated suite and report what happened.
 *
 * Repair (`--repair`) is the next slice; this command establishes the honest
 * reporting the repair loop will need. Two things it refuses to do:
 *
 * - report a run that never happened as a green suite;
 * - blame the tests when the application was unreachable.
 */
export function registerVerify(program: Command): void {
  program
    .command('verify')
    .description('Run the generated suite, classify failures, and write a RunReport')
    .option('-d, --dir <dir>', 'project directory', '.')
    .option('--feature <id>', 'run only this feature (matches its @feature: tag)')
    .option('--ready', 'skip tests tagged @needs-setup', false)
    .option('--repair', 'attempt to repair failing tests (max 2 iterations each)', false)
    .option('--no-llm', 'repair with verified selectors only — never call a model')
    .option('--no-health-check', 'run even if the app does not answer first')
    .option('-v, --verbose', 'verbose logging', false)
    .action(async (opts: VerifyOptions) => {
      await runVerify(opts);
    });
}

interface VerifyOptions {
  dir: string;
  feature?: string;
  ready: boolean;
  repair: boolean;
  /** commander maps `--no-llm` onto this, defaulting to true. */
  llm: boolean;
  /** commander maps `--no-health-check` onto this, defaulting to true. */
  healthCheck: boolean;
  verbose: boolean;
}

async function runVerify(opts: VerifyOptions): Promise<void> {
  const projectRoot = resolve(process.cwd(), opts.dir);
  const logger = createLogger({ verbose: opts.verbose });
  const { config } = await loadConfig(projectRoot);
  const suiteRoot = resolve(projectRoot, config.suiteDir);

  const startedAt = new Date();
  const health = opts.healthCheck
    ? await checkHealth({ baseUrl: config.baseUrl, logger })
    : { healthy: true, detail: 'health check skipped with --no-health-check' };

  if (!health.healthy) {
    // Say it before the run, not after twelve stack traces.
    console.log('');
    console.log(`The application is not reachable: ${health.detail}`);
    console.log('Running anyway so the report records it, but nothing here is a test defect.');
  }

  const outcome = runSuite({
    suiteRoot,
    logger,
    ...(opts.feature !== undefined ? { grep: `@feature:${opts.feature}` } : {}),
    ...(opts.ready ? { grepInvert: '@needs-setup' } : {}),
  });

  if (!outcome.ran) {
    // Never let "we could not run" read as "nothing failed".
    console.log('');
    console.log(`The suite was not run: ${outcome.notRunReason ?? 'no reason given'}`);
    process.exitCode = 1;
    return;
  }

  // Repair only runs against a healthy environment. Against an unhealthy one
  // every failure is `env` and `isRepairable` refuses it anyway, but stopping
  // here makes the reason visible instead of buried in per-test skips.
  const repairs: RepairSummary[] = [];
  let finalOutcome = outcome;
  if (opts.repair && health.healthy) {
    // The deterministic selector retry always runs. A model is consulted only
    // when that has nothing left to try, and only if one is actually available
    // — an absent key declines with a reason rather than failing the command.
    const llm = opts.llm ? resolveRepairModel(config, logger) : undefined;
    if (opts.repair && !opts.llm) {
      console.log('');
      console.log('Repairing with verified selectors only (--no-llm).');
    }
    finalOutcome = await repairFailures({
      projectRoot,
      suiteRoot,
      outcome,
      role: undefined,
      logger,
      repairs,
      ...(llm !== undefined ? { llm } : {}),
    });
  } else if (opts.repair) {
    console.log('');
    console.log('Skipping repair: the application was unreachable, so nothing here is');
    console.log('a test defect that a patch could fix.');
  }

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

  console.log('');
  console.log(formatRunSummary(report));

  const failures = report.tests.filter((t) => t.status === 'failed');
  if (failures.length > 0) {
    console.log('');
    console.log('Failures:');
    for (const failure of failures) {
      console.log(`  ✗ ${failure.title}`);
      console.log(`      ${failure.failureClass}: ${firstLine(failure.errorExcerpt)}`);
    }
  }

  // Assertion mismatches are the class that might be the application's fault
  // rather than the test's. Surfacing them separately is the point — a test
  // suite that finds a real bug has done its job.
  const suspects = failures.filter(
    (f) => f.failureClass !== undefined && mayBeAppDefect(f.failureClass),
  );
  if (report.envHealthy && suspects.length > 0) {
    console.log('');
    console.log(`${suspects.length} failure(s) are assertion mismatches — the application`);
    console.log('produced a value other than the one expected. That may be a real defect');
    console.log('rather than a broken test; check before changing the test.');
  }

  if (report.summary.flaky > 0) {
    console.log('');
    console.log(`${report.summary.flaky} test(s) passed only on retry and are marked flaky.`);
    console.log('Nothing in the code changed between attempts, so repair cannot help them.');
  }

  if (repairs.length > 0) {
    console.log('');
    console.log('Repairs:');
    for (const r of repairs) {
      console.log(`  ${r.repaired ? '✓' : '✗'} ${r.title}`);
      for (const line of r.detail) console.log(`      ${line}`);
    }
  }

  console.log('');
  console.log(`Report written to   ${relative(projectRoot, path) || path}`);

  const rate = passRate(report.summary);
  if (!report.envHealthy || failures.length > 0 || rate === undefined) {
    process.exitCode = 1;
  }
}

/**
 * Build the repair provider, or explain why there isn't one.
 *
 * A missing API key must not fail `flint verify --repair`: the deterministic
 * selector retry is the more valuable half and needs no model at all. So this
 * degrades to deterministic-only and says so, rather than aborting a run that
 * would have fixed something.
 */
function resolveRepairModel(
  config: FlintConfig,
  logger: Logger,
): { provider: AnthropicProvider; modelId: string; tokenBudget: number } | undefined {
  try {
    return {
      provider: new AnthropicProvider({ logger, logPrompts: config.debug.logPrompts }),
      modelId: config.models.repair,
      tokenBudget: config.tokenBudgets.repair,
    };
  } catch {
    console.log('');
    console.log('No ANTHROPIC_API_KEY, so repair will use verified selectors only.');
    console.log('Export a key to let a model look at failures the selector retry cannot fix.');
    return undefined;
  }
}

function firstLine(text: string | undefined): string {
  if (text === undefined) return '(no error text)';
  return text.split('\n')[0] ?? '(no error text)';
}
