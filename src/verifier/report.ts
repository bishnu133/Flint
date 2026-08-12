import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  RunReportSchema,
  type RunReport,
  type RunSummary,
  type TestResult,
} from '../schemas/run-report.js';
import { FlintError } from '../shared/errors.js';
import { formatZodError } from '../shared/zod-format.js';
import type { HealthResult } from './health.js';
import type { RunOutcome } from './runner.js';

/**
 * Assembling the RunReport, and writing it.
 *
 * The assembly is a pure function so the two rules that matter can be tested
 * without a browser:
 *
 * 1. **A failed health check rewrites every failure as `env`.** If the
 *    application was not reachable before the run, no test failure in that run
 *    tells you anything about the tests. Leaving them classified as
 *    selector-not-found would hand the repair loop a suite of correct tests to
 *    "fix" against a machine that was simply off.
 * 2. **`ran: false` is not a green suite.** A run that never happened produces
 *    a report that says so, rather than an empty test list that reads as
 *    success.
 */

export interface AssembleOptions {
  runId: string;
  startedAt: string;
  finishedAt: string;
  baseUrl: string;
  health: HealthResult;
  outcome: RunOutcome;
}

export function assembleRunReport(options: AssembleOptions): RunReport {
  const { health, outcome } = options;

  // Rule 1: an unhealthy environment reclassifies every failure. The test did
  // not fail — it never had a working application to run against.
  const tests = health.healthy ? outcome.tests : outcome.tests.map(asEnvFailure);

  const report: RunReport = {
    runId: options.runId,
    startedAt: options.startedAt,
    finishedAt: options.finishedAt,
    baseUrl: options.baseUrl,
    envHealthy: health.healthy,
    summary: summarise(tests),
    tests,
  };

  const parsed = RunReportSchema.safeParse(report);
  if (!parsed.success) {
    // Our own bug if this fires — better loud than a malformed report on disk.
    throw new FlintError(`Assembled an invalid RunReport:\n${formatZodError(parsed.error)}`, {
      code: 'VERIFY',
      hint: 'This is a Flint bug. Please report the feature and the run id.',
    });
  }
  return parsed.data;
}

function asEnvFailure(test: TestResult): TestResult {
  if (test.status !== 'failed') return test;
  return {
    ...test,
    failureClass: 'env',
    errorExcerpt:
      test.errorExcerpt === undefined
        ? 'the application was unreachable before this run started'
        : `[reclassified: the application was unreachable before this run started]\n${test.errorExcerpt}`,
    // An env failure is never an application defect claim: we never got far
    // enough to observe the application behaving wrongly.
    possibleAppDefect: false,
  };
}

export function summarise(tests: TestResult[]): RunSummary {
  const count = (status: TestResult['status']): number =>
    tests.filter((t) => t.status === status).length;
  return {
    total: tests.length,
    passed: count('passed'),
    failed: count('failed'),
    skipped: count('skipped'),
    flaky: count('flaky'),
    fixme: count('fixme'),
  };
}

/**
 * The pass rate the master plan's exit criteria are measured against.
 *
 * Denominator is tests that actually ran — skipped and fixme cases are excluded
 * because counting them would let a suite reach "100%" by running nothing,
 * which is exactly the failure mode the generate warning exists to catch.
 * Returns undefined when nothing ran, rather than a misleading 0 or 100.
 */
export function passRate(summary: RunSummary): number | undefined {
  const ran = summary.passed + summary.failed + summary.flaky;
  return ran === 0 ? undefined : summary.passed / ran;
}

export function reportsDir(projectRoot: string): string {
  return join(projectRoot, '.flint', 'reports');
}

export function reportPath(projectRoot: string, runId: string): string {
  return join(reportsDir(projectRoot), `${runId}.json`);
}

export function writeRunReport(path: string, report: RunReport): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

/** A run id that sorts chronologically and is safe as a filename. */
export function newRunId(now: Date = new Date()): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

/** A short human summary for the terminal. */
export function formatRunSummary(report: RunReport): string {
  const lines: string[] = [];
  const s = report.summary;
  lines.push(`Tests:            ${s.total}`);
  if (s.passed > 0) lines.push(`  passed          ${s.passed}`);
  if (s.failed > 0) lines.push(`  failed          ${s.failed}`);
  if (s.flaky > 0) lines.push(`  flaky           ${s.flaky}`);
  if (s.skipped > 0) lines.push(`  skipped         ${s.skipped}`);
  if (s.fixme > 0) lines.push(`  fixme           ${s.fixme}`);

  const rate = passRate(s);
  lines.push(
    rate === undefined
      ? 'Pass rate:        n/a — no test actually ran'
      : `Pass rate:        ${(rate * 100).toFixed(1)}% of the ${s.passed + s.failed + s.flaky} that ran`,
  );

  if (!report.envHealthy) {
    lines.push('');
    lines.push('The application was unreachable — these are environment failures,');
    lines.push('not test failures, and nothing will be repaired.');
  }
  return lines.join('\n');
}
