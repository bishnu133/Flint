import { describe, it, expect } from 'vitest';
import { emptiedSpecs, ownedByRun, testsInOwnedSpecs } from './shrink-guard.js';
import type { SuiteIndex } from '../schemas/suite-index.js';

/**
 * The line this guard draws: a spec going to zero is erasure and blocks the
 * run; a spec with fewer tests than last time is ordinary and does not.
 */

const BASELINE: SuiteIndex = {
  generatedAt: '2026-01-01T00:00:00.000Z',
  suiteDir: 'e2e',
  pageObjects: [],
  specs: [
    {
      file: 'e2e/tests/cart.spec.ts',
      testTitles: ['adds @feature:cart', 'removes @feature:cart'],
      tags: ['@feature:cart'],
    },
    {
      file: 'e2e/tests/login.spec.ts',
      testTitles: ['signs in @feature:login'],
      tags: ['@feature:login'],
    },
    { file: 'e2e/tests/hand.spec.ts', testTitles: ['written by a person'], tags: [] },
  ],
  fixtures: [],
  dataFactories: [],
  coverageMap: {
    cart: ['adds @feature:cart', 'removes @feature:cart'],
    login: ['signs in @feature:login'],
  },
  managedFiles: ['e2e/tests/cart.spec.ts', 'e2e/tests/login.spec.ts'],
  handEditedFiles: [],
};

describe('emptiedSpecs', () => {
  it('names a feature whose spec would be erased', () => {
    const emptied = emptiedSpecs({
      baseline: BASELINE,
      emitted: [
        { featureId: 'cart', tests: 0 },
        { featureId: 'login', tests: 1 },
      ],
    });
    expect(emptied).toEqual([{ featureId: 'cart', files: ['e2e/tests/cart.spec.ts'], tests: 2 }]);
  });

  it('allows a smaller plan — that is not erasure', () => {
    // The run the first version of this guard wrongly blocked: 13 tests became
    // 12 because one case merged into another.
    const emptied = emptiedSpecs({
      baseline: BASELINE,
      emitted: [
        { featureId: 'cart', tests: 1 },
        { featureId: 'login', tests: 1 },
      ],
    });
    expect(emptied).toEqual([]);
  });

  it('says nothing about a feature with no spec yet', () => {
    const emptied = emptiedSpecs({
      baseline: BASELINE,
      emitted: [{ featureId: 'checkout', tests: 0 }],
    });
    expect(emptied).toEqual([]);
  });

  it('ignores a hand-written spec it does not own', () => {
    // `hand.spec.ts` is not managed and no coverage claims it, so no feature
    // owns it and nothing here can erase it.
    const emptied = emptiedSpecs({
      baseline: BASELINE,
      emitted: [{ featureId: 'cart', tests: 0 }],
    });
    expect(emptied[0]?.files).toEqual(['e2e/tests/cart.spec.ts']);
  });
});

describe('testsInOwnedSpecs / ownedByRun', () => {
  it('counts only the owned files', () => {
    const owned = ownedByRun(BASELINE, ['cart', 'login']);
    expect([...owned].sort()).toEqual(['e2e/tests/cart.spec.ts', 'e2e/tests/login.spec.ts']);
    expect(testsInOwnedSpecs(BASELINE, owned)).toBe(3);
  });

  it('owns nothing for a feature with no coverage', () => {
    expect(ownedByRun(BASELINE, ['checkout']).size).toBe(0);
  });
});
