import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { emitFeature } from '../generator/emitter.js';
import { playwrightPomDialect } from '../generator/dialects/playwright-pom.js';
import { applyWrites, planWrites } from './writer.js';
import { runCompileGate } from './gate.js';
import { discoverSuiteFiles } from './suite-files.js';
import type { ScreenModel } from '../schemas/screen-model.js';
import type { TestPlan } from '../schemas/test-plan.js';
import { TestPlanSchema } from '../schemas/test-plan.js';
import { ScreenModelSchema } from '../schemas/screen-model.js';

/**
 * Phase 4's headline exit criterion, end to end and offline: a plan and a
 * Screen Model go in, real TypeScript comes out, it compiles, and generating a
 * second time changes nothing.
 *
 * The plan and model are parsed through their schemas first, so this cannot
 * pass on a shape the rest of the pipeline would reject.
 */

let projectRoot: string;
let suiteRoot: string;

const TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      types: [],
    },
    include: ['**/*.ts'],
  },
  null,
  2,
);

/**
 * A hand-written stand-in for `@playwright/test`, so the gate can typecheck
 * generated code without the real package being installed in a temp dir. It
 * declares only the surface the emitter uses — which doubles as an assertion
 * that the emitter uses nothing else.
 */
const PLAYWRIGHT_STUB = `
export interface Locator {
  click(): Promise<void>;
  fill(value: string): Promise<void>;
  selectOption(value: string): Promise<void>;
}
export interface Page {
  goto(url: string): Promise<void>;
  locator(selector: string): Locator;
  getByRole(role: string, options?: { name?: string; exact?: boolean }): Locator;
  getByLabel(text: string, options?: { exact?: boolean }): Locator;
  getByPlaceholder(text: string, options?: { exact?: boolean }): Locator;
  getByText(text: string, options?: { exact?: boolean }): Locator;
}
interface Expectation {
  toBeVisible(): Promise<void>;
  toBeHidden(): Promise<void>;
  toHaveText(text: string): Promise<void>;
  toHaveValue(value: string): Promise<void>;
  toHaveCount(n: number): Promise<void>;
  toHaveURL(url: string): Promise<void>;
}
export declare function expect(actual: unknown): Expectation;
interface TestFn {
  (title: string, body: (args: { page: Page }) => Promise<void>): void;
  describe(title: string, body: () => void): void;
  skip(title: string, body: (args: { page: Page }) => Promise<void>): void;
  fixme(title: string, body: () => Promise<void>): void;
}
export declare const test: TestFn;
`;

const MODEL: ScreenModel = ScreenModelSchema.parse({
  version: 'model-1',
  baseUrl: 'https://www.saucedemo.com',
  capturedAt: '2026-01-01T00:00:00.000Z',
  pages: [
    {
      id: 'page-root',
      url: 'https://www.saucedemo.com/',
      urlPattern: '/',
      title: 'Swag Labs',
      reachedVia: { kind: 'link', href: '/' },
      navTargets: [],
      capturedAt: '2026-01-01T00:00:00.000Z',
      elements: [
        el('el-user', 'textbox', 'Username'),
        el('el-pass', 'input', 'Password', 'label', 'Password'),
        el('el-login', 'button', 'Login'),
      ],
    },
    {
      id: 'page-inventory',
      url: 'https://www.saucedemo.com/inventory.html',
      urlPattern: '/inventory.html',
      title: 'Products',
      reachedVia: { kind: 'link', href: '/inventory.html' },
      navTargets: [],
      capturedAt: '2026-01-01T00:00:00.000Z',
      elements: [el('el-title', 'heading', 'Products')],
    },
  ],
});

function el(
  id: string,
  role: string,
  name: string,
  strategy = 'testid',
  value = `[data-testid="${id}"]`,
): unknown {
  return {
    id,
    role,
    name,
    tagName: 'input',
    boundingBox: { x: 0, y: 0, width: 10, height: 10 },
    states: { visible: true, enabled: true },
    selectorCandidates: [{ strategy, value, score: 100, unique: true, verified: true }],
  };
}

const PLAN: TestPlan = TestPlanSchema.parse({
  featureId: 'login',
  generatedAt: '2026-01-01T00:00:00.000Z',
  screenModelVersion: 'model-1',
  cases: [
    {
      id: 'valid-credentials-land-on-products',
      title: 'User with valid credentials lands on the products page',
      priority: 'p0',
      tags: ['@flint', '@feature:login'],
      status: 'new',
      acceptanceRefs: ['AC1'],
      steps: [
        { action: 'goto', value: 'https://www.saucedemo.com/' },
        { action: 'fill', elementRef: 'el-user', value: 'standard_user' },
        { action: 'fill', elementRef: 'el-pass', value: 'secret_sauce' },
        { action: 'click', elementRef: 'el-login' },
        {
          action: 'assert',
          assertion: { kind: 'url', expected: 'https://www.saucedemo.com/inventory.html' },
        },
        {
          action: 'assert',
          elementRef: 'el-title',
          assertion: { kind: 'visible', expected: true },
        },
      ],
    },
    {
      id: 'locked-out-user-sees-lockout-message',
      title: 'Locked-out user sees a message explaining the account is locked',
      priority: 'p0',
      tags: ['@flint', '@feature:login'],
      status: 'blocked',
      blockedReason: 'No lockout message element exists in the Screen Model.',
      steps: [],
    },
    {
      id: 'invalid-password-stays-put',
      title: 'User with an invalid password stays on the sign-in page',
      priority: 'p1',
      tags: ['@flint', '@feature:login'],
      status: 'new',
      prerequisites: [{ kind: 'data', description: 'the standard_user demo account exists' }],
      steps: [
        { action: 'goto', value: 'https://www.saucedemo.com/' },
        { action: 'fill', elementRef: 'el-pass', value: 'wrong' },
        { action: 'click', elementRef: 'el-login' },
        {
          action: 'assert',
          assertion: { kind: 'url', expected: 'https://www.saucedemo.com/' },
        },
      ],
    },
  ],
});

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'flint-generate-'));
  suiteRoot = join(projectRoot, 'e2e');
  mkdirSync(suiteRoot, { recursive: true });
  writeFileSync(join(suiteRoot, 'tsconfig.json'), TSCONFIG, 'utf8');
  // The stub stands in for the real package, which a temp dir cannot resolve.
  writeSuite('@playwright/test.ts', PLAYWRIGHT_STUB);
});
afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

function writeSuite(path: string, contents: string): void {
  const absolute = join(suiteRoot, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents, 'utf8');
}

function generate(): ReturnType<typeof emitFeature> {
  return emitFeature({
    plan: PLAN,
    model: MODEL,
    dialect: playwrightPomDialect,
    title: 'Sign in to Swag Labs',
  });
}

/** Rewrite the Playwright import to the local stub so the gate can resolve it. */
function withStubImports(result: ReturnType<typeof emitFeature>): ReturnType<typeof emitFeature> {
  return {
    ...result,
    files: result.files.map((file) => ({
      ...file,
      contents: file.contents.replace(
        /'@playwright\/test'/g,
        file.path.includes('/') ? `'../@playwright/test'` : `'./@playwright/test'`,
      ),
    })),
  };
}

describe('generate — end to end', () => {
  it('emits a suite that typechecks', () => {
    const result = withStubImports(generate());
    const decisions = planWrites({ suiteRoot, files: result.files });
    const gate = runCompileGate({
      projectRoot,
      suiteRoot,
      decisions,
      existingFiles: discoverSuiteFiles(suiteRoot),
    });
    expect(gate.ran).toBe(true);
    expect(gate.errors).toEqual([]);
  }, 60_000);

  it('writes the files, then reports nothing to do on a second run', () => {
    // The determinism exit criterion, observed the way a user would: run it
    // twice, and the second run leaves the working tree alone.
    const result = generate();
    const first = applyWrites(suiteRoot, planWrites({ suiteRoot, files: result.files }));
    expect(first.written).toBe(result.files.length);

    const second = applyWrites(suiteRoot, planWrites({ suiteRoot, files: generate().files }));
    expect(second.written).toBe(0);
    expect(second.decisions.every((d) => d.outcome === 'unchanged')).toBe(true);
  });

  it('produces a suite a human would recognise', () => {
    applyWrites(suiteRoot, planWrites({ suiteRoot, files: generate().files }));

    const spec = readFileSync(join(suiteRoot, 'tests/login.spec.ts'), 'utf8');
    expect(spec).toContain(`test.describe('Sign in to Swag Labs'`);
    expect(spec).toContain('await homePage.goto();');
    expect(spec).toContain(`await homePage.fillUsernameInput('standard_user');`);
    expect(spec).toContain('await homePage.clickLoginButton();');
    expect(spec).toContain('test.fixme(');
    expect(spec).toContain('test.skip(');

    const pageObject = readFileSync(join(suiteRoot, 'pages/home.page.ts'), 'utf8');
    // The password field's best candidate was a label, not a testid — the
    // emitter must use whatever won, not a preferred shape.
    expect(pageObject).toContain(`this.passwordInput = this.page.getByLabel('Password'`);
    expect(pageObject).toContain(`this.page.locator('[data-testid="el-user"]')`);
  });

  it('marks its files managed, so a later run knows it wrote them', () => {
    applyWrites(suiteRoot, planWrites({ suiteRoot, files: generate().files }));
    expect(readFileSync(join(suiteRoot, 'pages/home.page.ts'), 'utf8')).toMatch(
      /@flint:managed [a-f0-9]+/,
    );
  });

  it('keeps a human edit and writes beside it', () => {
    applyWrites(suiteRoot, planWrites({ suiteRoot, files: generate().files }));

    const path = join(suiteRoot, 'pages/home.page.ts');
    const edited = `${readFileSync(path, 'utf8')}\n// a human was here\n`;
    writeFileSync(path, edited, 'utf8');

    const applied = applyWrites(suiteRoot, planWrites({ suiteRoot, files: generate().files }));
    expect(readFileSync(path, 'utf8')).toBe(edited);
    expect(applied.diverted.map((d) => d.targetPath)).toEqual(['pages/home.page.flint.ts']);
  });
});
