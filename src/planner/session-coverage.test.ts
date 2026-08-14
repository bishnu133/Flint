import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestCase, TestPlan } from '../schemas/test-plan.js';
import { planPath, writePlan } from './store.js';
import { sessionCoverage } from './session-coverage.js';

/**
 * The property under test is the one that broke: a run's plans must inform the
 * *next* feature in the same run without ever reaching disk, so a failed gate
 * leaves no plan claiming coverage for a test that was never written.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'flint-session-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function testCase(title: string, status: TestCase['status'] = 'new'): TestCase {
  return {
    id: `c-${title.replace(/\s+/g, '-')}`,
    title,
    priority: 'p1',
    tags: [],
    status,
    ...(status === 'skipped-duplicate' || status === 'update-existing'
      ? { duplicateOf: 'some-test' }
      : {}),
    ...(status === 'blocked' ? { blockedReason: 'no such element' } : {}),
    steps: [],
  };
}

function plan(featureId: string, cases: TestCase[]): TestPlan {
  return {
    featureId,
    generatedAt: '2026-08-14T00:00:00.000Z',
    screenModelVersion: '1',
    cases,
  };
}

describe('sessionCoverage', () => {
  it('keeps history for features this run is not touching', () => {
    writePlan(planPath(root, 'search'), plan('search', [testCase('user can search')]));
    const coverage = sessionCoverage({
      projectRoot: root,
      runFeatures: ['login'],
      planned: new Map(),
      excludeFeature: 'login',
    });
    expect(coverage).toEqual({ search: ['user can search'] });
  });

  it('drops the stored plan of every feature in the run, not only the current one', () => {
    // `cart` is about to be re-planned in this same run, so its old plan is not
    // coverage — deduping `login` against it would preserve a test that is
    // being replaced.
    writePlan(planPath(root, 'login'), plan('login', [testCase('old login test')]));
    writePlan(planPath(root, 'cart'), plan('cart', [testCase('old cart test')]));
    writePlan(planPath(root, 'search'), plan('search', [testCase('user can search')]));

    const coverage = sessionCoverage({
      projectRoot: root,
      runFeatures: ['login', 'cart'],
      planned: new Map(),
      excludeFeature: 'login',
    });
    expect(coverage).toEqual({ search: ['user can search'] });
  });

  it('surfaces plans made earlier in the same run, without touching disk', () => {
    const coverage = sessionCoverage({
      projectRoot: root,
      runFeatures: ['login', 'cart'],
      planned: new Map([['login', plan('login', [testCase('user signs in')])]]),
      excludeFeature: 'cart',
    });
    expect(coverage).toEqual({ login: ['user signs in'] });
    // Nothing was persisted as a side effect — that is the whole point.
    expect(existsSync(join(root, '.flint', 'plans'))).toBe(false);
  });

  it('never counts the feature being planned, even once it is in the map', () => {
    const coverage = sessionCoverage({
      projectRoot: root,
      runFeatures: ['login'],
      planned: new Map([['login', plan('login', [testCase('user signs in')])]]),
      excludeFeature: 'login',
    });
    expect(coverage).toEqual({});
  });

  it('counts only cases the emitter will write', () => {
    const coverage = sessionCoverage({
      projectRoot: root,
      runFeatures: ['login', 'cart'],
      planned: new Map([
        [
          'login',
          plan('login', [
            testCase('written'),
            testCase('updated', 'update-existing'),
            testCase('a duplicate', 'skipped-duplicate'),
            testCase('blocked one', 'blocked'),
          ]),
        ],
      ]),
      excludeFeature: 'cart',
    });
    expect(coverage).toEqual({ login: ['updated', 'written'] });
  });

  it('omits a feature whose plan writes nothing at all', () => {
    const coverage = sessionCoverage({
      projectRoot: root,
      runFeatures: ['login', 'cart'],
      planned: new Map([['login', plan('login', [testCase('dupe', 'skipped-duplicate')])]]),
      excludeFeature: 'cart',
    });
    expect(coverage).toEqual({});
  });

  it('sorts titles, so the planner prompt is byte-stable across runs', () => {
    const coverage = sessionCoverage({
      projectRoot: root,
      runFeatures: ['login', 'cart'],
      planned: new Map([
        ['login', plan('login', [testCase('zebra'), testCase('alpha'), testCase('alpha')])],
      ]),
      excludeFeature: 'cart',
    });
    expect(coverage['login']).toEqual(['alpha', 'zebra']);
  });
});
