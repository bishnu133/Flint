import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assembleRunReport,
  formatRunSummary,
  newRunId,
  passRate,
  reportPath,
  summarise,
  writeRunReport,
} from './report.js';
import { RunReportSchema, type TestResult } from '../schemas/run-report.js';
import type { RunOutcome } from './runner.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'flint-report-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function test(over: Partial<TestResult> = {}): TestResult {
  return { title: 't', file: 'a.spec.ts', status: 'passed', repairAttempts: 0, ...over };
}

function outcome(tests: TestResult[]): RunOutcome {
  return { ran: true, tests, runErrors: [] };
}

const BASE = {
  runId: 'run-1',
  startedAt: '2026-08-12T00:00:00.000Z',
  finishedAt: '2026-08-12T00:01:00.000Z',
  baseUrl: 'https://app.example.com',
};

describe('assembleRunReport', () => {
  it('produces a report the LOCKED schema accepts', () => {
    const report = assembleRunReport({
      ...BASE,
      health: { healthy: true, detail: 'ok' },
      outcome: outcome([test(), test({ status: 'failed', failureClass: 'timeout' })]),
    });
    expect(RunReportSchema.safeParse(report).success).toBe(true);
    expect(report.summary).toEqual({
      total: 2,
      passed: 1,
      failed: 1,
      skipped: 0,
      flaky: 0,
      fixme: 0,
    });
  });

  it('reclassifies every failure as env when the app was unreachable', () => {
    // The exit criterion. Leaving these as selector-not-found would hand the
    // repair loop a suite of correct tests to "fix" against a stopped server.
    const report = assembleRunReport({
      ...BASE,
      health: { healthy: false, detail: 'connection refused' },
      outcome: outcome([
        test({ status: 'failed', failureClass: 'selector-not-found', errorExcerpt: 'no #login' }),
        test({ status: 'failed', failureClass: 'assertion-mismatch' }),
      ]),
    });
    expect(report.envHealthy).toBe(false);
    expect(report.tests.every((t) => t.failureClass === 'env')).toBe(true);
    expect(report.tests[0]?.errorExcerpt).toMatch(/unreachable/);
    // The original text survives, so nothing is lost by the reclassification.
    expect(report.tests[0]?.errorExcerpt).toContain('no #login');
  });

  it('never claims an application defect when the app was unreachable', () => {
    const report = assembleRunReport({
      ...BASE,
      health: { healthy: false, detail: 'down' },
      outcome: outcome([
        test({ status: 'failed', failureClass: 'assertion-mismatch', possibleAppDefect: true }),
      ]),
    });
    expect(report.tests[0]?.possibleAppDefect).toBe(false);
  });

  it('leaves passing and skipped tests alone even when the env is unhealthy', () => {
    const report = assembleRunReport({
      ...BASE,
      health: { healthy: false, detail: 'down' },
      outcome: outcome([test({ status: 'passed' }), test({ status: 'skipped' })]),
    });
    expect(report.tests.map((t) => t.status)).toEqual(['passed', 'skipped']);
    expect(report.tests.every((t) => t.failureClass === undefined)).toBe(true);
  });
});

describe('passRate', () => {
  it('measures only tests that actually ran', () => {
    // Counting skips in the denominator would let a suite reach 100% by
    // running nothing — the failure mode the generate warning exists to catch.
    expect(
      passRate(summarise([test(), test({ status: 'skipped' }), test({ status: 'fixme' })])),
    ).toBe(1);
  });

  it('counts a flaky test against the rate', () => {
    expect(passRate(summarise([test(), test({ status: 'flaky' })]))).toBe(0.5);
  });

  it('is undefined rather than 0 or 100 when nothing ran', () => {
    expect(passRate(summarise([test({ status: 'skipped' })]))).toBeUndefined();
    expect(passRate(summarise([]))).toBeUndefined();
  });
});

describe('formatRunSummary', () => {
  it('says n/a rather than a number when no test ran', () => {
    const report = assembleRunReport({
      ...BASE,
      health: { healthy: true, detail: 'ok' },
      outcome: outcome([test({ status: 'skipped' })]),
    });
    expect(formatRunSummary(report)).toMatch(/no test actually ran/);
  });

  it('explains an unhealthy environment rather than listing failures', () => {
    const report = assembleRunReport({
      ...BASE,
      health: { healthy: false, detail: 'down' },
      outcome: outcome([test({ status: 'failed', failureClass: 'timeout' })]),
    });
    expect(formatRunSummary(report)).toMatch(/unreachable/);
    expect(formatRunSummary(report)).toMatch(/nothing will be repaired/);
  });

  it('reports the rate against the tests that ran', () => {
    const report = assembleRunReport({
      ...BASE,
      health: { healthy: true, detail: 'ok' },
      outcome: outcome([test(), test(), test({ status: 'failed', failureClass: 'timeout' })]),
    });
    expect(formatRunSummary(report)).toMatch(/66\.7% of the 3 that ran/);
  });
});

describe('writeRunReport', () => {
  it('round-trips through disk', () => {
    const report = assembleRunReport({
      ...BASE,
      health: { healthy: true, detail: 'ok' },
      outcome: outcome([test()]),
    });
    const path = reportPath(root, report.runId);
    writeRunReport(path, report);
    expect(RunReportSchema.parse(JSON.parse(readFileSync(path, 'utf8')))).toEqual(report);
  });
});

describe('newRunId', () => {
  it('sorts chronologically and is safe as a filename', () => {
    const early = newRunId(new Date('2026-08-12T00:00:00.000Z'));
    const later = newRunId(new Date('2026-08-12T00:00:01.000Z'));
    expect(early < later).toBe(true);
    expect(early).not.toMatch(/[:.]/);
  });
});
