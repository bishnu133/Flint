import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  formatPlanSummary,
  planHistoryCoverage,
  planPath,
  plansDir,
  readAllPlans,
  readPlan,
  renderedPlanPath,
  tryReadPlan,
  writePlan,
} from './store.js';
import type { TestCase, TestPlan } from '../schemas/test-plan.js';
import { ConfigError } from '../shared/errors.js';
import { FlintError } from '../shared/errors.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'flint-plan-store-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function testCase(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: 'c1',
    title: 'User can sign in',
    priority: 'p0',
    tags: ['@flint'],
    status: 'new',
    steps: [],
    ...overrides,
  } as TestCase;
}

function plan(featureId: string, cases: TestCase[]): TestPlan {
  return {
    featureId,
    generatedAt: '2026-01-01T00:00:00.000Z',
    screenModelVersion: 'model-1',
    cases,
  };
}

describe('writePlan / readPlan', () => {
  it('round-trips a plan', () => {
    const path = planPath(root, 'login');
    const original = plan('login', [testCase()]);
    writePlan(path, original);
    expect(readPlan(path)).toEqual(original);
  });

  it('puts the rendered copy beside the JSON', () => {
    expect(renderedPlanPath(root, 'login')).toBe(join(plansDir(root), 'login.plan.md'));
  });

  it('errors actionably when the plan is missing', () => {
    expect(() => readPlan(planPath(root, 'nope'))).toThrowError(ConfigError);
    expect(() => readPlan(planPath(root, 'nope'))).toThrow(/No TestPlan at/);
  });

  it('errors actionably on malformed JSON', () => {
    const path = planPath(root, 'broken');
    mkdirSync(plansDir(root), { recursive: true });
    writeFileSync(path, '{ not json', 'utf8');
    expect(() => readPlan(path)).toThrow(/not valid JSON/);
  });

  it('rejects a plan that violates the schema, naming the key', () => {
    const path = planPath(root, 'invalid');
    mkdirSync(plansDir(root), { recursive: true });
    // skipped-duplicate requires duplicateOf.
    writeFileSync(
      path,
      JSON.stringify(plan('x', [testCase({ status: 'skipped-duplicate' })])),
      'utf8',
    );
    expect(() => readPlan(path)).toThrowError(FlintError);
    expect(() => readPlan(path)).toThrow(/duplicateOf/);
  });

  it('tryReadPlan returns undefined instead of throwing on a first run', () => {
    expect(tryReadPlan(planPath(root, 'nope'))).toBeUndefined();
  });
});

describe('readAllPlans', () => {
  it('returns an empty list before anything is planned', () => {
    expect(readAllPlans(root)).toEqual([]);
  });

  it('reads every plan in stable order', () => {
    writePlan(planPath(root, 'b'), plan('b', [testCase()]));
    writePlan(planPath(root, 'a'), plan('a', [testCase()]));
    expect(readAllPlans(root).map((p) => p.featureId)).toEqual(['a', 'b']);
  });

  it('skips a corrupt plan rather than losing the others', () => {
    writePlan(planPath(root, 'good'), plan('good', [testCase()]));
    writeFileSync(planPath(root, 'bad'), 'not json', 'utf8');
    expect(readAllPlans(root).map((p) => p.featureId)).toEqual(['good']);
  });
});

describe('planHistoryCoverage', () => {
  it('counts cases the Emitter will write', () => {
    writePlan(
      planPath(root, 'login'),
      plan('login', [
        testCase({ id: 'a', title: 'User can sign in', status: 'new' }),
        testCase({
          id: 'b',
          title: 'User can sign out',
          status: 'update-existing',
          duplicateOf: 'old test',
        }),
      ]),
    );
    expect(planHistoryCoverage(root)).toEqual({
      login: ['User can sign in', 'User can sign out'],
    });
  });

  it('excludes skipped-duplicate and blocked cases', () => {
    // A duplicate is already represented by the test it duplicates, and a
    // blocked case has no test at all — counting either would make a feature
    // look covered when nothing runs.
    writePlan(
      planPath(root, 'login'),
      plan('login', [
        testCase({ id: 'a', title: 'Dup', status: 'skipped-duplicate', duplicateOf: 'x' }),
        testCase({ id: 'b', title: 'Blocked', status: 'blocked', blockedReason: 'no UI' }),
      ]),
    );
    expect(planHistoryCoverage(root)).toEqual({});
  });

  it('merges plans across features', () => {
    writePlan(planPath(root, 'login'), plan('login', [testCase({ title: 'A' })]));
    writePlan(planPath(root, 'cart'), plan('cart', [testCase({ title: 'B' })]));
    expect(planHistoryCoverage(root)).toEqual({ login: ['A'], cart: ['B'] });
  });
});

describe('formatPlanSummary', () => {
  it('breaks down cases by status', () => {
    const text = formatPlanSummary(
      plan('login', [
        testCase({ id: 'a', status: 'new' }),
        testCase({ id: 'b', status: 'blocked', blockedReason: 'no UI' }),
      ]),
    );
    expect(text).toMatch(/Cases:\s+2/);
    expect(text).toMatch(/new\s+1/);
    expect(text).toMatch(/blocked\s+1/);
  });

  it('surfaces open questions, which are the point of asking them', () => {
    const text = formatPlanSummary({
      ...plan('login', [testCase()]),
      openQuestions: ['Which user role applies here?'],
    });
    expect(text).toMatch(/Open questions:\s+1/);
    expect(text).toContain('Which user role applies here?');
  });

  it('counts cases needing setup', () => {
    const text = formatPlanSummary(
      plan('login', [
        testCase({ prerequisites: [{ kind: 'data', description: 'a seeded user' }] }),
      ]),
    );
    expect(text).toMatch(/Needing setup:\s+1/);
  });
});
