import { describe, it, expect } from 'vitest';
import { countSuperseded, supersedeOwnGeneratedTests } from './supersede.js';
import type { SuiteIndex } from '../schemas/suite-index.js';

function index(over: Partial<SuiteIndex> = {}): SuiteIndex {
  return {
    generatedAt: '2026-01-01T00:00:00.000Z',
    suiteDir: 'e2e',
    pageObjects: [],
    specs: [],
    fixtures: [],
    dataFactories: [],
    coverageMap: {},
    managedFiles: [],
    handEditedFiles: [],
    ...over,
  };
}

/** The suite as it stands after `flint generate login` has run once. */
function afterGenerate(managed = true): SuiteIndex {
  return index({
    specs: [
      {
        file: 'e2e/tests/login.spec.ts',
        testTitles: ['User sees the sign-in form', 'User with valid credentials lands on products'],
        tags: ['@flint', '@feature:login'],
      },
    ],
    coverageMap: {
      login: ['User sees the sign-in form', 'User with valid credentials lands on products'],
    },
    managedFiles: managed ? ['e2e/tests/login.spec.ts'] : [],
    handEditedFiles: managed ? [] : ['e2e/tests/login.spec.ts'],
  });
}

describe('supersedeOwnGeneratedTests', () => {
  it('hides the feature’s own generated tests from its next plan', () => {
    // The regression: without this the planner marked all of them
    // skipped-duplicate, and the next generate rewrote the spec with only the
    // blocked cases — deleting working tests.
    const result = supersedeOwnGeneratedTests(afterGenerate(), 'login');
    expect(result.coverageMap.login).toBeUndefined();
  });

  it('keeps them once a human has edited the file', () => {
    // A hand-edited file holds human work. Deferring to it is the conservative
    // direction: at worst the planner skips a case a human can un-skip.
    const result = supersedeOwnGeneratedTests(afterGenerate(false), 'login');
    expect(result.coverageMap.login).toHaveLength(2);
  });

  it('keeps hand-written tests that happen to share the feature tag', () => {
    const withHandWritten = index({
      specs: [
        {
          file: 'e2e/tests/login.spec.ts',
          testTitles: ['Generated case'],
          tags: ['@feature:login'],
        },
        {
          file: 'e2e/tests/login-legacy.spec.ts',
          testTitles: ['A test somebody wrote by hand'],
          tags: ['@feature:login'],
        },
      ],
      coverageMap: { login: ['Generated case', 'A test somebody wrote by hand'] },
      managedFiles: ['e2e/tests/login.spec.ts'],
    });
    const result = supersedeOwnGeneratedTests(withHandWritten, 'login');
    expect(result.coverageMap.login).toEqual(['A test somebody wrote by hand']);
  });

  it('leaves other features alone — their coverage is real prior art', () => {
    const twoFeatures = index({
      specs: [
        { file: 'e2e/tests/login.spec.ts', testTitles: ['L1'], tags: ['@feature:login'] },
        { file: 'e2e/tests/cart.spec.ts', testTitles: ['C1'], tags: ['@feature:cart'] },
      ],
      coverageMap: { login: ['L1'], cart: ['C1'] },
      managedFiles: ['e2e/tests/login.spec.ts', 'e2e/tests/cart.spec.ts'],
    });
    const result = supersedeOwnGeneratedTests(twoFeatures, 'login');
    expect(result.coverageMap.login).toBeUndefined();
    expect(result.coverageMap.cart).toEqual(['C1']);
  });

  it('is a no-op on a first run, when nothing has been generated yet', () => {
    const fresh = index();
    expect(supersedeOwnGeneratedTests(fresh, 'login')).toBe(fresh);
  });

  it('does not mutate the index it is given', () => {
    const original = afterGenerate();
    const snapshot = JSON.stringify(original);
    supersedeOwnGeneratedTests(original, 'login');
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it('is idempotent', () => {
    const once = supersedeOwnGeneratedTests(afterGenerate(), 'login');
    expect(supersedeOwnGeneratedTests(once, 'login')).toEqual(once);
  });
});

describe('countSuperseded', () => {
  it('counts what this run will ignore, for the log line', () => {
    expect(countSuperseded(afterGenerate(), 'login')).toBe(2);
    expect(countSuperseded(afterGenerate(false), 'login')).toBe(0);
    expect(countSuperseded(index(), 'login')).toBe(0);
  });
});
