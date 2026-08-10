import { describe, it, expect } from 'vitest';
import { RunReportSchema, TestResultSchema } from './run-report.js';

const validReport = {
  runId: 'run-2026-08-10-0001',
  startedAt: '2026-08-10T00:00:00.000Z',
  finishedAt: '2026-08-10T00:01:00.000Z',
  baseUrl: 'https://app.example.com',
  envHealthy: true,
  summary: { total: 1, passed: 1, failed: 0, skipped: 0, flaky: 0, fixme: 0 },
  tests: [
    { title: 'logs in', file: 'e2e/tests/login.spec.ts', status: 'passed', repairAttempts: 0 },
  ],
};

describe('RunReportSchema', () => {
  it('accepts a well-formed report', () => {
    const parsed = RunReportSchema.parse(validReport);
    expect(parsed.summary.passed).toBe(1);
  });

  it('rejects a failed test with no failureClass, naming the field', () => {
    const result = TestResultSchema.safeParse({
      title: 'logs in',
      file: 'e2e/tests/login.spec.ts',
      status: 'failed',
      repairAttempts: 2,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes('failureClass'));
      expect(issue?.message).toMatch(/failed test requires a 'failureClass'/);
    }
  });

  it('rejects an unknown failureClass value with an enum message', () => {
    const result = TestResultSchema.safeParse({
      title: 'logs in',
      file: 'e2e/tests/login.spec.ts',
      status: 'failed',
      failureClass: 'flaky-network',
      repairAttempts: 1,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes('failureClass'));
      expect(issue?.message).toMatch(/selector-not-found/);
    }
  });

  it('rejects a negative repairAttempts count', () => {
    const result = TestResultSchema.safeParse({
      title: 'logs in',
      file: 'e2e/tests/login.spec.ts',
      status: 'passed',
      repairAttempts: -1,
    });
    expect(result.success).toBe(false);
  });
});
