import { describe, it, expect } from 'vitest';
import { gitignoreSuggestion, vendoredPaths, vendoredReasons } from './vendored.js';

/**
 * The failure this prevents is not subtle: a generated pull request containing
 * seven hundred files of `node_modules`, which is what `git add -- e2e` does in
 * a project with no `.gitignore`.
 */

describe('vendoredPaths', () => {
  it('catches the suite’s own dependencies', () => {
    expect(
      vendoredPaths([
        'e2e/tests/login.spec.ts',
        'e2e/node_modules/playwright/index.js',
        'e2e/pages/home.page.ts',
      ]),
    ).toEqual(['e2e/node_modules/playwright/index.js']);
  });

  it('catches run output and macOS litter', () => {
    expect(
      vendoredPaths([
        'e2e/test-results/.last-run.json',
        'e2e/playwright-report/index.html',
        'e2e/blob-report/report.zip',
        'kb/.DS_Store',
      ]),
    ).toHaveLength(4);
  });

  it('passes a clean suite through untouched', () => {
    const clean = ['.flint/plans/login.plan.json', 'e2e/tests/login.spec.ts'];
    expect(vendoredPaths(clean)).toEqual([]);
  });

  it('matches whole path segments, not substrings', () => {
    // A page object for a page *about* node modules is a test file, not vendor
    // code, and refusing to commit it would be its own bug.
    expect(vendoredPaths(['e2e/pages/node_modules-viewer.page.ts'])).toEqual([]);
    expect(vendoredPaths(['e2e/tests/test-results-page.spec.ts'])).toEqual([]);
  });

  it('preserves input order, so the printed list matches the file list', () => {
    expect(vendoredPaths(['e2e/node_modules/b.js', 'e2e/a.spec.ts', 'e2e/.DS_Store'])).toEqual([
      'e2e/node_modules/b.js',
      'e2e/.DS_Store',
    ]);
  });
});

describe('vendoredReasons', () => {
  it('names the causes once each, sorted, not every file', () => {
    expect(
      vendoredReasons([
        'e2e/node_modules/a.js',
        'e2e/node_modules/b.js',
        'e2e/test-results/x.json',
        'e2e/tests/login.spec.ts',
      ]),
    ).toEqual(['node_modules', 'test-results']);
  });
});

describe('gitignoreSuggestion', () => {
  it('is pasteable and covers the suite directory it was given', () => {
    const text = gitignoreSuggestion('tests-e2e');
    expect(text).toContain('tests-e2e/node_modules/');
    expect(text).toContain('tests-e2e/playwright-report/');
    expect(text).toContain('.DS_Store');
    expect(text).toContain('.env');
  });

  it('ignores everything it refuses to commit', () => {
    // Otherwise the refusal is unactionable: follow the advice, hit it again.
    const lines = gitignoreSuggestion('e2e')
      .split('\n')
      .map((line) => line.replace(/\/$/, ''));
    for (const offender of ['e2e/node_modules', 'e2e/test-results', '.DS_Store']) {
      expect(lines).toContain(offender);
    }
  });
});
