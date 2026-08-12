import { describe, it, expect } from 'vitest';
import { emitFeature } from './emitter.js';
import { playwrightPomDialect } from './dialects/playwright-pom.js';
import type { Element, Page, ScreenModel } from '../schemas/screen-model.js';
import type { TestCase, TestPlan } from '../schemas/test-plan.js';
import type { SelectorCandidate } from '../schemas/screen-model.js';

/**
 * Stage B is a pure transform, so every test here is offline and exact. The
 * emitted text is asserted directly: the suite Flint writes is the product, and
 * "it compiled" would not catch emitting the wrong selector.
 */

function candidate(over: Partial<SelectorCandidate> = {}): SelectorCandidate {
  return {
    strategy: 'testid',
    value: '[data-testid="x"]',
    score: 100,
    unique: true,
    verified: true,
    ...over,
  };
}

function element(
  id: string,
  role: string,
  name: string,
  over: Partial<Element> = {},
  candidates?: SelectorCandidate[],
): Element {
  return {
    id,
    role,
    name,
    tagName: 'input',
    boundingBox: { x: 0, y: 0, width: 10, height: 10 },
    states: { visible: true, enabled: true },
    selectorCandidates: candidates ?? [candidate({ value: `[data-testid="${id}"]` })],
    ...over,
  };
}

function page(id: string, urlPattern: string, elements: Element[], over: Partial<Page> = {}): Page {
  return {
    id,
    url: `https://shop.example.com${urlPattern === '/' ? '/' : urlPattern}`,
    urlPattern,
    title: urlPattern,
    reachedVia: { kind: 'link', href: urlPattern },
    navTargets: [],
    capturedAt: '2026-01-01T00:00:00.000Z',
    elements,
    ...over,
  };
}

const LOGIN_PAGE = page('page-login', '/login', [
  element('el-user', 'textbox', 'Username'),
  element('el-pass', 'textbox', 'Password'),
  element('el-submit', 'button', 'Login', { tagName: 'input' }),
  element('el-error', 'alert', 'Error message'),
]);

const INVENTORY_PAGE = page('page-inventory', '/inventory.html', [
  element('el-title', 'heading', 'Products'),
]);

const MODEL: ScreenModel = {
  version: 'model-1',
  baseUrl: 'https://shop.example.com',
  capturedAt: '2026-01-01T00:00:00.000Z',
  pages: [LOGIN_PAGE, INVENTORY_PAGE],
};

function testCase(over: Partial<TestCase> = {}): TestCase {
  return {
    id: 'valid-login',
    title: 'User with valid credentials lands on the products page',
    priority: 'p0',
    tags: ['@flint', '@feature:login'],
    status: 'new',
    steps: [
      { action: 'goto', value: 'https://shop.example.com/login' },
      { action: 'fill', elementRef: 'el-user', value: 'standard_user' },
      { action: 'fill', elementRef: 'el-pass', value: 'secret_sauce' },
      { action: 'click', elementRef: 'el-submit' },
      {
        action: 'assert',
        assertion: { kind: 'url', expected: 'https://shop.example.com/inventory.html' },
      },
      { action: 'assert', elementRef: 'el-title', assertion: { kind: 'visible', expected: true } },
    ],
    ...over,
  } as TestCase;
}

function plan(cases: TestCase[]): TestPlan {
  return {
    featureId: 'login',
    generatedAt: '2026-01-01T00:00:00.000Z',
    screenModelVersion: 'model-1',
    cases,
  };
}

function emit(cases: TestCase[], model: ScreenModel = MODEL) {
  return emitFeature({
    plan: plan(cases),
    model,
    dialect: playwrightPomDialect,
    title: 'Sign in',
  });
}

function fileNamed(result: ReturnType<typeof emit>, path: string): string {
  const file = result.files.find((f) => f.path === path);
  expect(file, `expected ${path} in ${result.files.map((f) => f.path).join(', ')}`).toBeDefined();
  return file!.contents;
}

describe('emitFeature — files', () => {
  it('writes one page object per page the feature touches, plus one spec', () => {
    const result = emit([testCase()]);
    expect(result.files.map((f) => f.path)).toEqual([
      'pages/inventory-html.page.ts',
      'pages/login.page.ts',
      'tests/login.spec.ts',
    ]);
  });

  it('does not write a page object for a page no step touches', () => {
    const result = emit([
      testCase({
        steps: [
          { action: 'goto', value: 'https://shop.example.com/login' },
          { action: 'click', elementRef: 'el-submit' },
        ],
      }),
    ]);
    expect(result.files.map((f) => f.path)).toEqual(['pages/login.page.ts', 'tests/login.spec.ts']);
  });

  it('writes nothing for a skipped-duplicate case but records it', () => {
    const result = emit([
      testCase({ id: 'dup', status: 'skipped-duplicate', duplicateOf: 'an existing test' }),
    ]);
    expect(result.skippedDuplicates).toEqual(['dup']);
    expect(fileNamed(result, 'tests/login.spec.ts')).not.toContain('dup');
  });
});

describe('emitFeature — page objects', () => {
  it('names locators from role and accessible name', () => {
    const source = fileNamed(emit([testCase()]), 'pages/login.page.ts');
    expect(source).toContain('readonly usernameInput: Locator;');
    expect(source).toContain('readonly passwordInput: Locator;');
    expect(source).toContain('readonly loginButton: Locator;');
  });

  it('uses the highest-scored verified-unique candidate, and records which', () => {
    const source = fileNamed(emit([testCase()]), 'pages/login.page.ts');
    expect(source).toContain(`this.loginButton = this.page.locator('[data-testid="el-submit"]');`);
    expect(source).toContain('// button "Login" — testid (score 100), el-submit');
  });

  it('falls to the next verified candidate when the top one is not unique', () => {
    // The LOCKED rule: a non-unique candidate is never emitted, whatever its
    // base score. Here the testid is duplicated in the app, so role wins.
    const model: ScreenModel = {
      ...MODEL,
      pages: [
        page('page-login', '/login', [
          element('el-submit', 'button', 'Login', {}, [
            candidate({ value: '[data-testid="dup"]', score: 30, unique: false }),
            candidate({
              strategy: 'role',
              value: 'button[name="Login"]',
              score: 85,
              unique: true,
            }),
          ]),
        ]),
      ],
    };
    const source = fileNamed(
      emit([testCase({ steps: [{ action: 'click', elementRef: 'el-submit' }] })], model),
      'pages/login.page.ts',
    );
    expect(source).toContain(
      `this.loginButton = this.page.getByRole('button', { name: 'Login', exact: true });`,
    );
    expect(source).not.toContain('data-testid="dup"');
  });

  it('emits one method per action-element pair, deduped across cases', () => {
    const source = fileNamed(
      emit([testCase({ id: 'a' }), testCase({ id: 'b' })]),
      'pages/login.page.ts',
    );
    expect(source.match(/async fillUsernameInput/g)).toHaveLength(1);
    expect(source).toContain('async fillUsernameInput(value: string): Promise<void> {');
    expect(source).toContain('await this.usernameInput.fill(value);');
    expect(source).toContain('async clickLoginButton(): Promise<void> {');
  });

  it('gives every page object a goto() carrying its own URL', () => {
    const source = fileNamed(emit([testCase()]), 'pages/login.page.ts');
    expect(source).toContain(`await this.page.goto('https://shop.example.com/login');`);
  });

  it('imports only types from Playwright, so the output has no Flint dependency', () => {
    const source = fileNamed(emit([testCase()]), 'pages/login.page.ts');
    expect(source).toContain(`import type { Locator, Page } from '@playwright/test';`);
    expect(source).not.toMatch(/from '.*flint/i);
  });
});

describe('emitFeature — specs', () => {
  it("navigates through the page object's own goto, keeping the URL in one place", () => {
    const source = fileNamed(emit([testCase()]), 'tests/login.spec.ts');
    expect(source).toContain('await loginPage.goto();');
    expect(source).not.toContain(`await page.goto('https://shop.example.com/login');`);
  });

  it('falls back to a bare page.goto for a URL no page object owns', () => {
    const source = fileNamed(
      emit([testCase({ steps: [{ action: 'goto', value: 'https://shop.example.com/other' }] })]),
      'tests/login.spec.ts',
    );
    expect(source).toContain(`await page.goto('https://shop.example.com/other');`);
  });

  it('reads as a Playwright test using the page objects', () => {
    const source = fileNamed(emit([testCase()]), 'tests/login.spec.ts');
    expect(source).toContain(`import { test, expect } from '@playwright/test';`);
    expect(source).toContain(`import { LoginPage } from '../pages/login.page';`);
    expect(source).toContain(`test.describe('Sign in', () => {`);
    expect(source).toContain('const loginPage = new LoginPage(page);');
    expect(source).toContain(`await loginPage.fillUsernameInput('standard_user');`);
    expect(source).toContain('await loginPage.clickLoginButton();');
  });

  it('carries the tags in the title, which is how the indexer reads them back', () => {
    const source = fileNamed(emit([testCase()]), 'tests/login.spec.ts');
    expect(source).toContain(
      `test('User with valid credentials lands on the products page @feature:login @flint'`,
    );
  });

  it('records the plan case id so a run report maps back to the plan', () => {
    expect(fileNamed(emit([testCase()]), 'tests/login.spec.ts')).toContain(
      '// plan case: valid-login',
    );
  });

  it('renders each assertion kind as the matching Playwright expectation', () => {
    const source = fileNamed(
      emit([
        testCase({
          steps: [
            {
              action: 'assert',
              elementRef: 'el-error',
              assertion: { kind: 'visible', expected: true },
            },
            {
              action: 'assert',
              elementRef: 'el-error',
              assertion: { kind: 'hidden', expected: true },
            },
            {
              action: 'assert',
              elementRef: 'el-error',
              assertion: { kind: 'text', expected: 'Wrong password' },
            },
            {
              action: 'assert',
              elementRef: 'el-user',
              assertion: { kind: 'value', expected: 'bob' },
            },
            { action: 'assert', elementRef: 'el-error', assertion: { kind: 'count', expected: 2 } },
            { action: 'assert', assertion: { kind: 'url', expected: 'https://shop.example.com/' } },
          ],
        }),
      ]),
      'tests/login.spec.ts',
    );
    expect(source).toContain('await expect(loginPage.errorMessageAlert).toBeVisible();');
    expect(source).toContain('await expect(loginPage.errorMessageAlert).toBeHidden();');
    expect(source).toContain(
      `await expect(loginPage.errorMessageAlert).toHaveText('Wrong password');`,
    );
    expect(source).toContain(`await expect(loginPage.usernameInput).toHaveValue('bob');`);
    expect(source).toContain('await expect(loginPage.errorMessageAlert).toHaveCount(2);');
    expect(source).toContain(`await expect(page).toHaveURL('https://shop.example.com/');`);
  });

  it('treats visible:false as toBeHidden rather than a negated visible check', () => {
    const source = fileNamed(
      emit([
        testCase({
          steps: [
            {
              action: 'assert',
              elementRef: 'el-error',
              assertion: { kind: 'visible', expected: false },
            },
          ],
        }),
      ]),
      'tests/login.spec.ts',
    );
    expect(source).toContain('await expect(loginPage.errorMessageAlert).toBeHidden();');
  });

  it('turns a custom step into a comment rather than inventing code', () => {
    const source = fileNamed(
      emit([
        testCase({
          steps: [{ action: 'custom', note: 'Check the confirmation email arrives' }],
        }),
      ]),
      'tests/login.spec.ts',
    );
    expect(source).toContain('// Check the confirmation email arrives');
  });
});

describe('emitFeature — degraded cases', () => {
  it('emits a blocked case as test.fixme carrying the reason', () => {
    const result = emit([
      testCase({ status: 'blocked', blockedReason: 'no error banner was ever captured' }),
    ]);
    const source = fileNamed(result, 'tests/login.spec.ts');
    expect(source).toContain('test.fixme(');
    expect(source).toContain('// no error banner was ever captured');
    expect(result.degraded).toEqual([
      expect.objectContaining({ caseId: 'valid-login', mode: 'fixme' }),
    ]);
  });

  it('emits test.fixme when no candidate was verified unique', () => {
    // The anti-invention guard, at the last possible moment before code exists.
    const model: ScreenModel = {
      ...MODEL,
      pages: [
        page('page-login', '/login', [
          element('el-submit', 'button', 'Login', {}, [candidate({ score: 30, unique: false })]),
        ]),
      ],
    };
    const result = emit(
      [testCase({ steps: [{ action: 'click', elementRef: 'el-submit' }] })],
      model,
    );
    const source = fileNamed(result, 'tests/login.spec.ts');
    expect(source).toContain('test.fixme(');
    expect(source).toContain('no verified-unique selector for el-submit');
    // …and nothing was emitted that pretends to address it.
    expect(source).not.toContain('clickLoginButton');
  });

  it('emits the complete test but skipped when the case needs setup', () => {
    const result = emit([
      testCase({ prerequisites: [{ kind: 'data', description: 'a seeded standard_user' }] }),
    ]);
    const source = fileNamed(result, 'tests/login.spec.ts');
    expect(source).toContain('test.skip(');
    // "complete" matters: Phase 5 must not waste repair attempts on it, but a
    // human unskipping it should find a real test, not a stub.
    expect(source).toContain(`await loginPage.fillUsernameInput('standard_user');`);
    expect(source).toContain('// needs data: a seeded standard_user');
    expect(result.degraded[0]?.mode).toBe('skip');
  });

  it('refuses to address an element inside an iframe', () => {
    // Uniqueness was verified inside the frame; the selector for the frame
    // itself never was, so emitting one would break the core guarantee.
    const model: ScreenModel = {
      ...MODEL,
      pages: [
        page('page-login', '/login', [
          element('el-submit', 'button', 'Login', { framePath: ['checkout-widget'] }),
        ]),
      ],
    };
    const result = emit(
      [testCase({ steps: [{ action: 'click', elementRef: 'el-submit' }] })],
      model,
    );
    expect(fileNamed(result, 'tests/login.spec.ts')).toContain('lives inside an iframe');
  });
});

describe('emitFeature — determinism', () => {
  it('regenerating the same feature is byte-identical', () => {
    const first = emit([testCase({ id: 'a' }), testCase({ id: 'b' })]);
    const second = emit([testCase({ id: 'a' }), testCase({ id: 'b' })]);
    expect(second.files).toEqual(first.files);
  });

  it('is unaffected by the order elements appear in the Screen Model', () => {
    const reordered: ScreenModel = {
      ...MODEL,
      pages: [page('page-login', '/login', [...LOGIN_PAGE.elements].reverse()), INVENTORY_PAGE],
    };
    expect(emit([testCase()], reordered).files).toEqual(emit([testCase()]).files);
  });

  it('gives two pages with the same derived class name distinct names', () => {
    const model: ScreenModel = {
      ...MODEL,
      pages: [
        page('page-a', '/login', [element('el-a', 'button', 'Go')]),
        page('page-b', '/login/', [element('el-b', 'button', 'Stop')]),
      ],
    };
    const result = emit(
      [
        testCase({
          steps: [
            { action: 'click', elementRef: 'el-a' },
            { action: 'click', elementRef: 'el-b' },
          ],
        }),
      ],
      model,
    );
    expect(result.pageObjects).toEqual(['LoginPage', 'LoginPage2']);
  });
});
