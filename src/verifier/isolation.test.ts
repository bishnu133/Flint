import { describe, it, expect } from 'vitest';
import { collisionAdvice, isolationVerdict, markFlaky } from './isolation.js';
import { TestResultSchema, type TestResult } from '../schemas/run-report.js';

function result(over: Partial<TestResult> = {}): TestResult {
  return {
    title: 'signs in',
    file: 'tests/login.spec.ts',
    status: 'failed',
    failureClass: 'assertion-mismatch',
    errorExcerpt: 'Expected: "Welcome"\nReceived: "Error"',
    repairAttempts: 0,
    ...over,
  };
}

describe('isolationVerdict', () => {
  it('calls a test flaky when it passes alone', () => {
    expect(isolationVerdict(result({ status: 'passed', failureClass: undefined }))).toBe('flaky');
  });

  it('calls it genuine when it fails alone too', () => {
    expect(isolationVerdict(result())).toBe('genuine');
  });

  it('is inconclusive when the isolated run did not happen', () => {
    // "We could not find out" must never collapse into "it is fine". Repair
    // proceeds on inconclusive, because leaving a genuinely broken test alone
    // on the strength of a run that never happened is the Phase 5 mistake.
    expect(isolationVerdict(undefined)).toBe('inconclusive');
  });
});

describe('markFlaky', () => {
  it('re-badges the test as flaky and drops the failure class', () => {
    const flaky = markFlaky(result());
    expect(flaky.status).toBe('flaky');
    expect(flaky.failureClass).toBeUndefined();
  });

  it('keeps the error text, which is the evidence of what interfered', () => {
    // A "flaky" label with no error leaves a human nothing to act on.
    expect(markFlaky(result()).errorExcerpt).toContain('Received');
  });

  it('produces a result the LOCKED schema accepts', () => {
    // `failed` requires a failureClass; `flaky` must not carry one that implies
    // a diagnosis nobody made.
    expect(TestResultSchema.safeParse(markFlaky(result())).success).toBe(true);
  });
});

describe('collisionAdvice', () => {
  it('says nothing when nothing was flaky', () => {
    expect(collisionAdvice([])).toEqual([]);
  });

  it('names the tests and gives two concrete remedies', () => {
    const text = collisionAdvice(['signs in', 'adds to cart']).join('\n');
    expect(text).toContain('signs in');
    expect(text).toContain('adds to cart');
    expect(text).toMatch(/--workers=1/);
    expect(text).toMatch(/serial|unique/);
  });

  it('says plainly that repair will not touch them', () => {
    // The master plan is explicit: flaky is not repaired. The report has to say
    // so, or a user waits for a fix that is never coming.
    expect(collisionAdvice(['signs in']).join('\n')).toMatch(/repair will not touch them/);
  });
});
