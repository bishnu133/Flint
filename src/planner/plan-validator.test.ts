import { describe, it, expect } from 'vitest';
import {
  applyDuplicateDetection,
  checkElementRefs,
  formatReferentialReport,
  titleSimilarity,
} from './plan-validator.js';
import type { TestCase, TestPlan } from '../schemas/test-plan.js';
import type { SuiteIndex } from '../schemas/suite-index.js';

/**
 * These two checks are what stop a plausible-sounding plan from becoming a
 * broken test suite, so they are pure functions with table-driven tests.
 */

function testCase(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: 'case-1',
    title: 'User can sign in',
    priority: 'p0',
    tags: ['@flint', '@feature:auth'],
    status: 'new',
    steps: [],
    ...overrides,
  } as TestCase;
}

function plan(cases: TestCase[], featureId = 'auth'): TestPlan {
  return {
    featureId,
    generatedAt: '2026-01-01T00:00:00.000Z',
    screenModelVersion: '1',
    cases,
  };
}

function index(coverage: Record<string, string[]>): SuiteIndex {
  return {
    generatedAt: '2026-01-01T00:00:00.000Z',
    suiteDir: 'e2e',
    pageObjects: [],
    specs: [],
    fixtures: [],
    dataFactories: [],
    coverageMap: coverage,
    managedFiles: [],
    handEditedFiles: [],
  };
}

describe('checkElementRefs', () => {
  const allowed = new Set(['el-1', 'el-2']);

  it('passes when every reference exists', () => {
    const report = checkElementRefs(
      plan([testCase({ steps: [{ action: 'click', elementRef: 'el-1' }] })]),
      allowed,
    );
    expect(report.ok).toBe(true);
    expect(formatReferentialReport(report)).toMatch(/All element references resolve/);
  });

  it('rejects an invented element id', () => {
    const report = checkElementRefs(
      plan([testCase({ steps: [{ action: 'click', elementRef: 'el-imaginary' }] })]),
      allowed,
    );
    expect(report.ok).toBe(false);
    expect(report.unknown).toEqual([
      { caseId: 'case-1', stepIndex: 0, elementRef: 'el-imaginary' },
    ]);
    // The message has to name the case, the step and the id to be actionable.
    const text = formatReferentialReport(report);
    expect(text).toContain('case-1');
    expect(text).toContain('step 1');
    expect(text).toContain('el-imaginary');
  });

  it('ignores steps with no element reference', () => {
    const report = checkElementRefs(
      plan([testCase({ steps: [{ action: 'goto', value: '/' }] })]),
      allowed,
    );
    expect(report.ok).toBe(true);
  });

  it('exempts blocked cases, whose whole point is missing UI', () => {
    const report = checkElementRefs(
      plan([
        testCase({
          status: 'blocked',
          blockedReason: 'no export button in the Screen Model',
          steps: [{ action: 'click', elementRef: 'el-does-not-exist' }],
        }),
      ]),
      allowed,
    );
    expect(report.ok).toBe(true);
  });

  it('reports every offender, not just the first', () => {
    const report = checkElementRefs(
      plan([
        testCase({ id: 'a', steps: [{ action: 'click', elementRef: 'nope-1' }] }),
        testCase({ id: 'b', steps: [{ action: 'click', elementRef: 'nope-2' }] }),
      ]),
      allowed,
    );
    expect(report.unknown).toHaveLength(2);
  });
});

describe('titleSimilarity', () => {
  const cases: Array<[string, string, 'same' | 'different']> = [
    ['User can sign in', 'User can sign in', 'same'],
    ['User can sign in', 'User signs in', 'same'],
    ['User can sign in @flint @feature:auth', 'User can sign in', 'same'],
    ['User can sign in', 'User cannot sign in with a bad password', 'different'],
    ['User can sign in', 'User can sign out', 'different'],
    ['User can add an item to the cart', 'User can remove an item from the cart', 'different'],
    ['', 'User can sign in', 'different'],
  ];

  for (const [a, b, expected] of cases) {
    it(`${expected}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`, () => {
      const score = titleSimilarity(a, b);
      if (expected === 'same') expect(score).toBeGreaterThanOrEqual(0.8);
      else expect(score).toBeLessThan(0.8);
    });
  }

  it('treats a negated title as a different behaviour however similar the words', () => {
    // The expensive mistake: silently dropping the negative case.
    expect(titleSimilarity('Login succeeds', 'Login fails')).toBe(0);
  });
});

describe('applyDuplicateDetection', () => {
  it('forces skipped-duplicate when the suite already covers the behaviour', () => {
    const result = applyDuplicateDetection(
      plan([testCase({ title: 'User signs in' })]),
      index({ auth: ['User can sign in'] }),
    );
    expect(result.plan.cases[0]!.status).toBe('skipped-duplicate');
    expect(result.plan.cases[0]!.duplicateOf).toBe('User can sign in');
    expect(result.forced).toHaveLength(1);
  });

  it('leaves a genuinely new case alone', () => {
    const result = applyDuplicateDetection(
      plan([testCase({ title: 'User can reset their password' })]),
      index({ auth: ['User can sign in'] }),
    );
    expect(result.plan.cases[0]!.status).toBe('new');
    expect(result.forced).toEqual([]);
  });

  it('does not collapse a negative case into its positive twin', () => {
    const result = applyDuplicateDetection(
      plan([testCase({ title: 'User cannot sign in with a bad password' })]),
      index({ auth: ['User can sign in'] }),
    );
    expect(result.plan.cases[0]!.status).toBe('new');
  });

  it('only considers coverage for the same feature id', () => {
    // An identical title under another feature is usually different behaviour.
    const result = applyDuplicateDetection(
      plan([testCase({ title: 'User can sign in' })], 'auth'),
      index({ checkout: ['User can sign in'] }),
    );
    expect(result.plan.cases[0]!.status).toBe('new');
  });

  it('never overrides a decision the planner made explicitly', () => {
    const result = applyDuplicateDetection(
      plan([
        testCase({
          title: 'User can sign in',
          status: 'update-existing',
          duplicateOf: 'User can sign in',
        }),
      ]),
      index({ auth: ['User can sign in'] }),
    );
    expect(result.plan.cases[0]!.status).toBe('update-existing');
    expect(result.forced).toEqual([]);
  });

  it('is a no-op when the feature has no existing coverage', () => {
    const original = plan([testCase()]);
    const result = applyDuplicateDetection(original, index({}));
    expect(result.plan).toBe(original);
    expect(result.forced).toEqual([]);
  });

  it('produces a schema-valid plan after forcing duplicates', () => {
    // skipped-duplicate requires duplicateOf; forcing must satisfy that.
    const result = applyDuplicateDetection(
      plan([testCase({ title: 'User signs in' })]),
      index({ auth: ['User can sign in'] }),
    );
    const forced = result.plan.cases[0]!;
    expect(forced.status).toBe('skipped-duplicate');
    expect(forced.duplicateOf).toBeDefined();
  });
});
