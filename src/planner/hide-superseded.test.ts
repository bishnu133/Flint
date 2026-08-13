import { describe, it, expect } from 'vitest';
import { hideSupersededTests, testsInOwnedSpecs } from './hide-superseded.js';
import type { SuiteIndex } from '../schemas/suite-index.js';

/**
 * The live defect these pin: hiding a feature's own tests from the coverage map
 * is not hiding them from the planner, because the prompt also lists every test
 * title in the suite. A `ci` run deleted ten working tests through that gap.
 */

function index(over: Partial<SuiteIndex> = {}): SuiteIndex {
  return {
    generatedAt: '2026-01-01T00:00:00.000Z',
    suiteDir: 'e2e',
    pageObjects: [],
    specs: [
      {
        file: 'e2e/tests/cart.spec.ts',
        testTitles: ['adds an item @feature:cart', 'removes an item @feature:cart'],
        tags: ['@feature:cart'],
      },
      {
        file: 'e2e/tests/login.spec.ts',
        testTitles: ['signs in @feature:login'],
        tags: ['@feature:login'],
      },
    ],
    fixtures: [],
    dataFactories: [],
    coverageMap: {
      cart: ['adds an item @feature:cart', 'removes an item @feature:cart'],
      login: ['signs in @feature:login'],
    },
    managedFiles: ['e2e/tests/cart.spec.ts', 'e2e/tests/login.spec.ts'],
    handEditedFiles: [],
    ...over,
  };
}

const titlesIn = (i: SuiteIndex, file: string): string[] =>
  i.specs.find((s) => s.file === file)?.testTitles ?? [];

describe('hideSupersededTests', () => {
  it('hides the feature’s own titles from the existing-tests list', () => {
    const hidden = hideSupersededTests(index(), 'cart');
    expect(titlesIn(hidden, 'e2e/tests/cart.spec.ts')).toEqual([]);
    expect(hidden.coverageMap['cart']).toBeUndefined();
  });

  it('leaves another feature’s tests visible — those are real prior art', () => {
    const hidden = hideSupersededTests(index(), 'cart');
    expect(titlesIn(hidden, 'e2e/tests/login.spec.ts')).toEqual(['signs in @feature:login']);
    expect(hidden.coverageMap['login']).toEqual(['signs in @feature:login']);
  });

  it('keeps hand-edited tests visible: a human owns those now', () => {
    const hidden = hideSupersededTests(
      index({ managedFiles: ['e2e/tests/login.spec.ts'] }),
      'cart',
    );
    expect(titlesIn(hidden, 'e2e/tests/cart.spec.ts')).toHaveLength(2);
  });

  it('keeps the spec entry itself — the file still exists', () => {
    const hidden = hideSupersededTests(index(), 'cart');
    expect(hidden.specs.map((s) => s.file)).toEqual([
      'e2e/tests/cart.spec.ts',
      'e2e/tests/login.spec.ts',
    ]);
  });

  it('is a no-op for a feature with no coverage yet', () => {
    expect(hideSupersededTests(index(), 'checkout')).toEqual(index());
  });

  it('does not hide a title the feature’s coverage does not claim', () => {
    // A managed file can hold tests from more than one feature.
    const mixed = index({
      specs: [
        {
          file: 'e2e/tests/cart.spec.ts',
          testTitles: ['adds an item @feature:cart', 'signs in @feature:login'],
          tags: ['@feature:cart', '@feature:login'],
        },
      ],
      coverageMap: { cart: ['adds an item @feature:cart'], login: ['signs in @feature:login'] },
      managedFiles: ['e2e/tests/cart.spec.ts'],
    });
    expect(titlesIn(hideSupersededTests(mixed, 'cart'), 'e2e/tests/cart.spec.ts')).toEqual([
      'signs in @feature:login',
    ]);
  });
});

describe('testsInOwnedSpecs', () => {
  it('counts only the files named', () => {
    expect(testsInOwnedSpecs(index(), new Set(['e2e/tests/cart.spec.ts']))).toBe(2);
    expect(
      testsInOwnedSpecs(index(), new Set(['e2e/tests/cart.spec.ts', 'e2e/tests/login.spec.ts'])),
    ).toBe(3);
  });

  it('is zero when nothing is owned', () => {
    expect(testsInOwnedSpecs(index(), new Set())).toBe(0);
  });
});
