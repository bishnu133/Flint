import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { scanSuite } from './scan.js';
import { withMarker } from './managed.js';
import { SuiteIndexSchema } from '../schemas/suite-index.js';

/**
 * The indexer reads suites it did not write. Half these tests are about
 * conventions being followed; the other half are about them not being.
 */

let root: string;

function write(relativePath: string, contents: string): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'flint-index-'));

  // --- a conventional suite -------------------------------------------------
  write(
    'e2e/pages/login.page.ts',
    `import type { Page } from '@playwright/test';
     export class LoginPage {
       constructor(private readonly page: Page) {}
       async goto() { await this.page.goto('/login'); }
       async signIn(user: string, pass: string) {
         await this.page.getByTestId('user-name').fill(user);
         await this.page.locator('#password').fill(pass);
         await this.page.getByRole('button', { name: 'Login' }).click();
       }
     }`,
  );
  write(
    'e2e/pages/inventory.page.ts',
    `import type { Page } from '@playwright/test';
     export class InventoryPage {
       readonly cart = this.page.locator('.shopping_cart_link');
       constructor(private readonly page: Page) {}
       async addBackpack() { await this.page.getByTestId('add-to-cart-backpack').click(); }
     }
     class NotExported { async hidden() {} }`,
  );
  write(
    'e2e/tests/login.spec.ts',
    `import { test, expect } from '@playwright/test';
     test.describe('Login @flint', () => {
       test('User can sign in @feature:auth-1', async ({ page }) => { await page.goto('/'); });
       test.skip('Locked-out user sees an error @feature:auth-1', async () => {});
       test.only('Session persists @feature:auth-2', async () => {});
     });`,
  );
  write(
    'e2e/tests/checkout.spec.ts',
    `import { test } from '@playwright/test';
     test('User can check out', { tag: ['@flint', '@feature:checkout-1'] }, async () => {});`,
  );
  write('e2e/fixtures/auth.fixture.ts', `export const test = 1; export const expect = 2;`);
  write('e2e/data/user.factory.ts', `export function makeUser() { return { name: 'a' }; }`);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function scan(overrides: Partial<Parameters<typeof scanSuite>[0]> = {}) {
  return scanSuite({ projectRoot: root, suiteDir: 'e2e', ...overrides });
}

describe('scanSuite — conventional suite', () => {
  it('produces a schema-valid index', () => {
    expect(SuiteIndexSchema.safeParse(scan().index).success).toBe(true);
  });

  it('finds exported page-object classes and skips unexported ones', () => {
    const names = scan().index.pageObjects.map((p) => p.className);
    expect(names).toContain('LoginPage');
    expect(names).toContain('InventoryPage');
    expect(names).not.toContain('NotExported');
  });

  it('extracts methods per page object', () => {
    const login = scan().index.pageObjects.find((p) => p.className === 'LoginPage')!;
    expect(login.methods.map((m) => m.name).sort()).toEqual(['goto', 'signIn']);
  });

  it('records the selectors a method uses', () => {
    const login = scan().index.pageObjects.find((p) => p.className === 'LoginPage')!;
    const signIn = login.methods.find((m) => m.name === 'signIn')!;
    expect(signIn.selectorsUsed).toContain('user-name');
    expect(signIn.selectorsUsed).toContain('#password');
    // `goto('/login')` is navigation, not a selector.
    expect(login.methods.find((m) => m.name === 'goto')!.selectorsUsed).toEqual([]);
  });

  it('picks up selectors from property initialisers, not just methods', () => {
    const inventory = scan().index.pageObjects.find((p) => p.className === 'InventoryPage')!;
    expect(inventory.selectorsUsed).toContain('.shopping_cart_link');
  });

  it('collects test titles including skipped and only', () => {
    const spec = scan().index.specs.find((s) => s.file.endsWith('login.spec.ts'))!;
    expect(spec.testTitles).toHaveLength(3);
    expect(spec.testTitles.some((t) => t.startsWith('Locked-out user'))).toBe(true);
    expect(spec.testTitles.some((t) => t.startsWith('Session persists'))).toBe(true);
  });

  it('collects tags from titles and from describe blocks', () => {
    const spec = scan().index.specs.find((s) => s.file.endsWith('login.spec.ts'))!;
    expect(spec.tags).toContain('@flint');
    expect(spec.tags).toContain('@feature:auth-1');
    expect(spec.tags).toContain('@feature:auth-2');
  });

  it('collects tags from the options-object form', () => {
    const spec = scan().index.specs.find((s) => s.file.endsWith('checkout.spec.ts'))!;
    expect(spec.tags).toContain('@flint');
    expect(spec.tags).toContain('@feature:checkout-1');
  });

  it('builds a coverage map from @feature tags', () => {
    const coverage = scan().index.coverageMap;
    expect(Object.keys(coverage).sort()).toEqual(['auth-1', 'auth-2', 'checkout-1']);
    expect(coverage['checkout-1']).toEqual(['User can check out']);
  });

  it('merges plan history into the coverage map', () => {
    const coverage = scan({ planHistory: { 'auth-1': ['planned-only'] } }).index.coverageMap;
    expect(coverage['auth-1']).toContain('planned-only');
    expect(coverage['auth-1']!.length).toBeGreaterThan(1);
  });

  it('finds fixtures and data factories', () => {
    const index = scan().index;
    expect(index.fixtures.map((f) => f.name).sort()).toEqual(['expect', 'test']);
    expect(index.dataFactories.map((f) => f.name)).toEqual(['makeUser']);
  });

  it('reports paths relative to the project root, posix style', () => {
    for (const spec of scan().index.specs) {
      expect(spec.file.startsWith('e2e/')).toBe(true);
      expect(spec.file).not.toContain('\\');
    }
  });

  it('is deterministic — two scans produce identical output bar the timestamp', () => {
    const a = { ...scan().index, generatedAt: '' };
    const b = { ...scan().index, generatedAt: '' };
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});

describe('scanSuite — managed-file detection', () => {
  it('separates generated, hand-edited and hand-written files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flint-managed-'));
    const body = `export class GenPage { async go() {} }\n`;
    mkdirSync(join(dir, 'e2e', 'pages'), { recursive: true });
    writeFileSync(join(dir, 'e2e/pages/gen.page.ts'), withMarker(body), 'utf8');
    writeFileSync(
      join(dir, 'e2e/pages/edited.page.ts'),
      `${withMarker(body)}// a human added this\n`,
      'utf8',
    );
    writeFileSync(join(dir, 'e2e/pages/manual.page.ts'), body, 'utf8');

    const index = scanSuite({ projectRoot: dir, suiteDir: 'e2e' }).index;
    expect(index.managedFiles).toEqual(['e2e/pages/gen.page.ts']);
    expect(index.handEditedFiles).toEqual(['e2e/pages/edited.page.ts']);
    // Hand-written files appear in neither list, but are still indexed.
    expect(index.pageObjects).toHaveLength(3);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('scanSuite — suites that ignore our conventions', () => {
  it('indexes a flat suite with no pages/ or tests/ directories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flint-flat-'));
    mkdirSync(join(dir, 'suite'), { recursive: true });
    writeFileSync(
      join(dir, 'suite/everything.ts'),
      `export class Thing { async click() { await this.page.locator('.x').click(); } }
       test('it works @feature:f1', async () => {});`,
      'utf8',
    );
    const index = scanSuite({ projectRoot: dir, suiteDir: 'suite' }).index;
    // One file, both a page object and a spec.
    expect(index.pageObjects.map((p) => p.className)).toEqual(['Thing']);
    expect(index.specs[0]!.testTitles).toEqual(['it works @feature:f1']);
    expect(index.coverageMap['f1']).toEqual(['it works @feature:f1']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('indexes `it(` as well as `test(`', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flint-it-'));
    mkdirSync(join(dir, 'e2e'), { recursive: true });
    writeFileSync(join(dir, 'e2e/legacy.spec.ts'), `it('old style', () => {});`, 'utf8');
    const index = scanSuite({ projectRoot: dir, suiteDir: 'e2e' }).index;
    expect(index.specs[0]!.testTitles).toEqual(['old style']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('skips a file with a syntax error and keeps going', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flint-broken-'));
    mkdirSync(join(dir, 'e2e'), { recursive: true });
    writeFileSync(join(dir, 'e2e/broken.ts'), 'export class Oops { async (((( }', 'utf8');
    writeFileSync(join(dir, 'e2e/fine.spec.ts'), `test('still indexed', () => {});`, 'utf8');
    const result = scanSuite({ projectRoot: dir, suiteDir: 'e2e' });
    // The good file is present regardless of what the broken one did.
    expect(result.index.specs.map((s) => s.file)).toContain('e2e/fine.spec.ts');
    expect(SuiteIndexSchema.safeParse(result.index).success).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('indexes only the configured suite dir, not the whole monorepo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flint-mono-'));
    mkdirSync(join(dir, 'packages/app/src'), { recursive: true });
    mkdirSync(join(dir, 'packages/app/e2e'), { recursive: true });
    writeFileSync(join(dir, 'packages/app/src/App.ts'), 'export class App {}', 'utf8');
    writeFileSync(join(dir, 'packages/app/e2e/a.spec.ts'), `test('t', () => {});`, 'utf8');
    const index = scanSuite({ projectRoot: dir, suiteDir: 'packages/app/e2e' }).index;
    expect(index.pageObjects).toHaveLength(0);
    expect(index.specs).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('ignores node_modules inside the suite dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flint-nm-'));
    mkdirSync(join(dir, 'e2e/node_modules/pkg'), { recursive: true });
    writeFileSync(join(dir, 'e2e/node_modules/pkg/index.ts'), 'export class Vendor {}', 'utf8');
    writeFileSync(join(dir, 'e2e/real.spec.ts'), `test('t', () => {});`, 'utf8');
    const index = scanSuite({ projectRoot: dir, suiteDir: 'e2e' }).index;
    expect(index.pageObjects).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('scanSuite — empty and missing suites', () => {
  it('produces a valid empty index for an empty suite dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flint-empty-'));
    mkdirSync(join(dir, 'e2e'), { recursive: true });
    const result = scanSuite({ projectRoot: dir, suiteDir: 'e2e' });
    expect(SuiteIndexSchema.safeParse(result.index).success).toBe(true);
    expect(result.index.specs).toEqual([]);
    expect(result.suiteMissing).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('produces a valid empty index when the suite dir does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flint-none-'));
    const result = scanSuite({ projectRoot: dir, suiteDir: 'nope' });
    expect(SuiteIndexSchema.safeParse(result.index).success).toBe(true);
    expect(result.suiteMissing).toBe(true);
    expect(result.index.pageObjects).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('scanSuite — performance', () => {
  it('indexes a 50-file suite in under 10 seconds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flint-perf-'));
    mkdirSync(join(dir, 'e2e/pages'), { recursive: true });
    mkdirSync(join(dir, 'e2e/tests'), { recursive: true });
    for (let i = 0; i < 25; i += 1) {
      writeFileSync(
        join(dir, `e2e/pages/p${i}.page.ts`),
        `export class P${i}Page {
           async a() { await this.page.getByTestId('t${i}-a').click(); }
           async b() { await this.page.locator('#b${i}').fill('x'); }
         }`,
        'utf8',
      );
      writeFileSync(
        join(dir, `e2e/tests/s${i}.spec.ts`),
        `test('case ${i} @flint @feature:f${i}', async () => {});
         test('case ${i} negative @feature:f${i}', async () => {});`,
        'utf8',
      );
    }
    const started = Date.now();
    const result = scanSuite({ projectRoot: dir, suiteDir: 'e2e' });
    const elapsed = Date.now() - started;

    expect(result.index.pageObjects).toHaveLength(25);
    expect(result.index.specs).toHaveLength(25);
    expect(Object.keys(result.index.coverageMap)).toHaveLength(25);
    expect(elapsed).toBeLessThan(10_000);
    console.log(`[exit criteria] indexed 50 files in ${elapsed}ms`);
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});
