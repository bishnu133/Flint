import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { reportDrift } from './report.js';
import { emitFeature } from '../generator/emitter.js';
import { playwrightPomDialect } from '../generator/dialects/playwright-pom.js';
import { applyWrites, planWrites } from '../integrator/writer.js';
import { writePageObjectRecords } from '../generator/page-object-store.js';
import { planPath, writePlan } from '../planner/store.js';
import {
  canonicalize,
  diffModels,
  modelPath,
  readModel,
  writeModel,
} from '../explorer/screen-model-store.js';
import { FlintConfigSchema, type FlintConfig } from '../schemas/config.js';
import { ScreenModelSchema, type ScreenModel } from '../schemas/screen-model.js';
import { TestPlanSchema, type TestPlan } from '../schemas/test-plan.js';

/**
 * Phase 6.2's exit criterion, end to end and offline.
 *
 * A suite is generated, the application then drifts, and drift mode has to do
 * two different things depending on what kind of drift it was:
 *
 *  - a selector was renamed  -> re-point the page objects, keep the specs
 *  - an element disappeared  -> refuse, because a re-point cannot fix it
 *
 * The second case is the one worth having a test for. Writing page objects that
 * no longer satisfy the specs would leave the suite broken in exactly the way
 * the Phase 4 compile-gate guarantee exists to prevent.
 */

let projectRoot: string;
let suiteRoot: string;
let logs: string[];

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
 * Installed as a real package under the suite's `node_modules` rather than
 * rewritten into the imports: drift mode emits the files itself, so the test
 * cannot reach in and patch them. A missing package would make the gate skip,
 * and a skipped gate would make the refusal test pass for the wrong reason.
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

function el(id: string, role: string, name: string, testIdValue = id): unknown {
  return {
    id,
    role,
    name,
    tagName: role === 'button' ? 'button' : 'input',
    boundingBox: { x: 0, y: 0, width: 10, height: 10 },
    states: { visible: true, enabled: true },
    selectorCandidates: [
      {
        strategy: 'testid',
        value: `[data-testid="${testIdValue}"]`,
        score: 100,
        unique: true,
        verified: true,
      },
    ],
  };
}

function buildModel(elements: unknown[]): ScreenModel {
  return ScreenModelSchema.parse({
    version: 'model-1',
    baseUrl: 'https://shop.example.com',
    capturedAt: '2026-01-01T00:00:00.000Z',
    pages: [
      {
        id: 'page-root',
        url: 'https://shop.example.com/',
        urlPattern: '/',
        title: 'Sign in',
        reachedVia: { kind: 'link', href: '/' },
        navTargets: [],
        capturedAt: '2026-01-01T00:00:00.000Z',
        elements,
      },
    ],
  });
}

const V1 = buildModel([el('el-user', 'textbox', 'Username'), el('el-login', 'button', 'Login')]);
/** The app renamed a `data-testid`. Same elements, new addresses. */
const V2 = buildModel([
  el('el-user', 'textbox', 'Username', 'username-field'),
  el('el-login', 'button', 'Login'),
]);
/** The app dropped the button entirely. No address can be re-pointed. */
const V3 = buildModel([el('el-user', 'textbox', 'Username')]);

const PLAN: TestPlan = TestPlanSchema.parse({
  featureId: 'login',
  generatedAt: '2026-01-01T00:00:00.000Z',
  screenModelVersion: 'model-1',
  cases: [
    {
      id: 'signs-in',
      title: 'User with valid credentials signs in',
      priority: 'p0',
      tags: ['@flint', '@feature:login'],
      status: 'new',
      steps: [
        { action: 'goto', value: 'https://shop.example.com/' },
        { action: 'fill', elementRef: 'el-user', value: 'standard_user' },
        { action: 'click', elementRef: 'el-login' },
        { action: 'assert', elementRef: 'el-user', assertion: { kind: 'visible', expected: true } },
      ],
    },
  ],
});

const config: FlintConfig = FlintConfigSchema.parse({
  baseUrl: 'https://shop.example.com',
  envClass: 'test',
  models: { planner: 'a', coder: 'b', repair: 'c' },
});

const PAGE_OBJECT = 'pages/home.page.ts';
const SPEC = 'tests/login.spec.ts';

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'flint-drift-'));
  suiteRoot = join(projectRoot, 'e2e');
  mkdirSync(suiteRoot, { recursive: true });
  writeFileSync(join(suiteRoot, 'tsconfig.json'), TSCONFIG, 'utf8');
  writeSuite(
    'node_modules/@playwright/test/package.json',
    JSON.stringify({ name: '@playwright/test', version: '1.0.0', types: 'index.d.ts' }),
  );
  writeSuite('node_modules/@playwright/test/index.d.ts', PLAYWRIGHT_STUB);

  // The state a real project is in before it drifts: a generated suite, the
  // model it came from, the plan, and the page-object record.
  const emitted = emitFeature({
    plan: PLAN,
    model: V1,
    dialect: playwrightPomDialect,
    title: 'Sign in',
  });
  applyWrites(suiteRoot, planWrites({ suiteRoot, files: emitted.files }));
  writePageObjectRecords(projectRoot, emitted.pageObjectRecords);
  writePlan(planPath(projectRoot, 'login'), PLAN);
  writeModel(modelPath(projectRoot), V1);

  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(projectRoot, { recursive: true, force: true });
});

function writeSuite(path: string, contents: string): void {
  const absolute = join(suiteRoot, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents, 'utf8');
}

function read(path: string): string {
  return readFileSync(join(suiteRoot, path), 'utf8');
}

function drift(after: ScreenModel, fix: boolean) {
  return reportDrift({
    projectRoot,
    config,
    before: V1,
    after,
    diff: diffModels(V1, after),
    modelFile: modelPath(projectRoot),
    fix,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never,
  });
}

describe('drift mode — end to end', () => {
  it('names the test a renamed selector puts at risk, and changes nothing', () => {
    const specBefore = read(SPEC);
    const pageObjectBefore = read(PAGE_OBJECT);

    const outcome = drift(V2, false);

    expect(outcome.resolved).toBe(false);
    expect(outcome.impact.affectedTests.map((t) => t.testId)).toEqual([
      'User with valid credentials signs in @feature:login @flint',
    ]);
    expect(read(SPEC)).toBe(specBefore);
    expect(read(PAGE_OBJECT)).toBe(pageObjectBefore);
    expect(logs.join('\n')).toContain('flint explore --diff --fix-page-objects');
  }, 60_000);

  it('re-points the page object and leaves the spec byte-identical', () => {
    const specBefore = read(SPEC);

    const outcome = drift(V2, true);

    expect(outcome.resolved).toBe(true);
    expect(read(PAGE_OBJECT)).toContain('[data-testid="username-field"]');
    expect(read(PAGE_OBJECT)).not.toContain('[data-testid="el-user"]');
    // The whole promise of a page-object-only repair.
    expect(read(SPEC)).toBe(specBefore);
    // And the model on disk is now the one the page objects were built from,
    // so the next --diff is clean.
    expect(readModel(modelPath(projectRoot))).toEqual(canonicalize(V2));
  }, 60_000);

  it('refuses when an element is gone, leaving the suite untouched', () => {
    const specBefore = read(SPEC);
    const pageObjectBefore = read(PAGE_OBJECT);

    const outcome = drift(V3, true);

    expect(outcome.resolved).toBe(false);
    expect(read(SPEC)).toBe(specBefore);
    expect(read(PAGE_OBJECT)).toBe(pageObjectBefore);
    // The model must not move either: accepting it would hide the drift.
    expect(readModel(modelPath(projectRoot))).toEqual(canonicalize(V1));

    const output = logs.join('\n');
    expect(output).toContain('Page objects were NOT written');
    expect(output).toContain('Re-plan instead:  flint ci');
  }, 60_000);
});
