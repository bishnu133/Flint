import { describe, it, expect } from 'vitest';
import {
  disablesTest,
  introducesUnverifiedSelector,
  locatorCalls,
  proposeRepair,
  receivedValue,
  renderElements,
  validateProposal,
  verifiedExpressions,
  weakensAssertion,
  type RepairFile,
} from './llm-repair.js';
import { FakeProvider } from '../llm/fake.js';
import { ProviderError, StructuredOutputError } from '../shared/errors.js';
import type { LLMProvider } from '../llm/types.js';
import type { Element, ScreenModel, SelectorCandidate } from '../schemas/screen-model.js';
import type { TestResult } from '../schemas/run-report.js';

/**
 * These tests are the actual safety mechanism.
 *
 * The prompt asks the model not to invent selectors, weaken assertions or skip
 * tests. Asking is not enforcement — a model under pressure to make a test pass
 * will do all three, and the failure mode is a *green* suite, which nobody
 * investigates. Every rule therefore gets a test that feeds the module a
 * proposal breaking it and asserts the proposal is thrown away.
 */

function candidate(over: Partial<SelectorCandidate> = {}): SelectorCandidate {
  return {
    strategy: 'testid',
    value: '[data-test="login"]',
    score: 100,
    unique: true,
    verified: true,
    ...over,
  };
}

const LOGIN: Element = {
  id: 'el-login',
  role: 'button',
  name: 'Login',
  tagName: 'button',
  boundingBox: { x: 0, y: 0, width: 1, height: 1 },
  states: { visible: true, enabled: true },
  selectorCandidates: [
    candidate(),
    candidate({ strategy: 'role', value: 'button[name="Login"]', score: 85 }),
    // Never verified: must never become available to the model.
    candidate({ strategy: 'text', value: 'Sign in', score: 55, verified: false }),
  ],
};

const MODEL: ScreenModel = {
  version: 'm',
  baseUrl: 'https://app.example.com',
  capturedAt: '2026-01-01T00:00:00.000Z',
  pages: [
    {
      id: 'p1',
      url: 'https://app.example.com/',
      urlPattern: '/',
      title: 'Home',
      reachedVia: { kind: 'link', href: '/' },
      navTargets: [],
      capturedAt: '2026-01-01T00:00:00.000Z',
      elements: [LOGIN],
    },
  ],
};

const PAGE_OBJECT = `export class HomePage {
  constructor(page) {
    this.page = page;
    this.loginButton = this.page.locator('[data-test="login"]');
  }
}
`;

const SPEC = `test('signs in', async ({ page }) => {
  const home = new HomePage(page);
  await home.loginButton.click();
  expect(await page.title()).toBe('Welcome');
});
`;

function files(): RepairFile[] {
  return [
    { path: 'tests/login.spec.ts', contents: SPEC },
    { path: 'pages/home.page.ts', contents: PAGE_OBJECT },
  ];
}

function check(edits: Array<{ file: string; find: string; replace: string }>, error?: string) {
  return validateProposal({
    proposal: { diagnosis: 'because', edits },
    files: files(),
    model: MODEL,
    failureClass: 'selector-not-found',
    errorExcerpt: error,
  });
}

describe('verifiedExpressions', () => {
  it('offers both roots, because a locator can move between spec and page object', () => {
    const allowed = verifiedExpressions(MODEL);
    expect(allowed.has(`this.page.locator('[data-test="login"]')`)).toBe(true);
    expect(allowed.has(`page.locator('[data-test="login"]')`)).toBe(true);
  });

  it('excludes candidates the explorer did not verify', () => {
    const allowed = [...verifiedExpressions(MODEL)].join('\n');
    expect(allowed).not.toContain('Sign in');
  });
});

describe('locatorCalls', () => {
  it('finds the locator calls in a chunk of code', () => {
    expect(locatorCalls(`this.page.getByRole('button', { name: 'Login' })`)).toEqual([
      `this.page.getByRole('button', { name: 'Login' })`,
    ]);
  });

  it('finds nothing in code that has none', () => {
    expect(locatorCalls('await expect(x).toBe(1);')).toEqual([]);
  });
});

describe('introducesUnverifiedSelector', () => {
  it('catches a selector that was never verified', () => {
    const invented = introducesUnverifiedSelector(
      `this.page.locator('[data-test="login"]')`,
      `this.page.locator('#login-btn')`,
      PAGE_OBJECT,
      verifiedExpressions(MODEL),
    );
    expect(invented).toBe(`this.page.locator('#login-btn')`);
  });

  it('allows a swap to another verified candidate', () => {
    expect(
      introducesUnverifiedSelector(
        `this.page.locator('[data-test="login"]')`,
        `this.page.getByRole('button', { name: 'Login', exact: true })`,
        PAGE_OBJECT,
        verifiedExpressions(MODEL),
      ),
    ).toBeUndefined();
  });

  it('allows moving a locator that is already in the file', () => {
    // Relocating an existing locator introduces no new selector, so it is not
    // the risk this check exists for.
    expect(
      introducesUnverifiedSelector(
        'const x = 1;',
        `this.page.locator('[data-test="login"]')`,
        PAGE_OBJECT,
        new Set<string>(),
      ),
    ).toBeUndefined();
  });
});

describe('disablesTest', () => {
  it.each([
    ['test.skip', 'test.skip(true);'],
    ['test.fixme', 'test.fixme();'],
    ['test.only', 'test.only("x", async () => {});'],
  ])('catches %s', (marker, code) => {
    expect(disablesTest('const x = 1;', code)).toBe(marker);
  });

  it('catches an empty catch block', () => {
    expect(disablesTest('await go();', 'try { await go(); } catch {}')).toMatch(/catch/);
  });

  it('catches a deleted assertion', () => {
    const before = `expect(a).toBe(1);\nexpect(b).toBe(2);`;
    expect(disablesTest(before, 'expect(a).toBe(1);')).toMatch(/removed assertion/);
  });

  it('allows adding an assertion', () => {
    expect(
      disablesTest('expect(a).toBe(1);', `await expect(x).toBeVisible();\nexpect(a).toBe(1);`),
    ).toBeUndefined();
  });
});

describe('receivedValue', () => {
  it.each([
    ['Expected: "Welcome"\nReceived: "Error"', 'Error'],
    ['Expected string: "a"\nReceived string: "b"', 'b'],
    ['Received: 404', '404'],
  ])('reads what the app actually produced from %s', (error, expected) => {
    expect(receivedValue(error)).toBe(expected);
  });

  it('returns nothing when the error reports no received value', () => {
    expect(receivedValue('Timeout 30000ms exceeded')).toBeUndefined();
    expect(receivedValue(undefined)).toBeUndefined();
  });
});

describe('weakensAssertion', () => {
  it('catches the expectation being rewritten to whatever the app produced', () => {
    // The single most damaging repair available: the test goes green and a real
    // application defect ships.
    expect(
      weakensAssertion(
        `expect(await page.title()).toBe('Welcome');`,
        `expect(await page.title()).toBe('Error');`,
        'Expected: "Welcome"\nReceived: "Error"',
      ),
    ).toBe('Error');
  });

  it('does not fire when the received value was already in the code', () => {
    const line = `expect(msg).toContain('Error');`;
    expect(weakensAssertion(line, `${line}\nawait wait();`, 'Received: "Error"')).toBeUndefined();
  });

  it('does not fire on a failure with no received value', () => {
    expect(weakensAssertion('a', 'b', 'Timeout 30000ms exceeded')).toBeUndefined();
  });
});

describe('validateProposal', () => {
  it('applies a clean edit and returns the new file contents', () => {
    const result = check([
      {
        file: 'pages/home.page.ts',
        find: `this.page.locator('[data-test="login"]')`,
        replace: `this.page.getByRole('button', { name: 'Login', exact: true })`,
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.contents).toContain('getByRole');
    expect(result.files[0]?.contents).not.toContain('data-test="login"');
  });

  it('accepts a model that declines, and writes nothing', () => {
    // Declining must be cheap and safe, or the model learns to guess instead.
    const result = check([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files).toEqual([]);
  });

  it('rejects an edit to a file the model was not shown', () => {
    const result = check([{ file: 'src/app.ts', find: 'a', replace: 'b' }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/not one of the files/);
  });

  it('rejects an edit whose find text is not in the file', () => {
    const result = check([{ file: 'pages/home.page.ts', find: 'this.nonexistent', replace: 'x' }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/quoted text that is not there/);
  });

  it('rejects an ambiguous edit that matches more than once', () => {
    const result = check([{ file: 'pages/home.page.ts', find: 'page', replace: 'x' }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/ambiguous/);
  });

  it('rejects an invented selector', () => {
    const result = check([
      {
        file: 'pages/home.page.ts',
        find: `this.page.locator('[data-test="login"]')`,
        replace: `this.page.locator('button.btn-primary')`,
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/invented a selector/);
  });

  it('rejects a weakened assertion and says the app may be at fault', () => {
    const result = check(
      [
        {
          file: 'tests/login.spec.ts',
          find: `expect(await page.title()).toBe('Welcome');`,
          replace: `expect(await page.title()).toBe('Error');`,
        },
      ],
      'Expected: "Welcome"\nReceived: "Error"',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/may be the thing that is wrong/);
  });

  it('rejects a skipped test', () => {
    const result = check([
      {
        file: 'tests/login.spec.ts',
        find: `  const home = new HomePage(page);`,
        replace: `  test.skip();\n  const home = new HomePage(page);`,
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/disable the test/);
  });

  it('rejects the whole proposal when any one edit is bad', () => {
    // All-or-nothing: a half-applied repair leaves a file in a state neither
    // Flint nor the model intended.
    const result = check([
      {
        file: 'pages/home.page.ts',
        find: `this.page.locator('[data-test="login"]')`,
        replace: `this.page.getByRole('button', { name: 'Login', exact: true })`,
      },
      { file: 'tests/login.spec.ts', find: 'not in the file', replace: 'x' },
    ]);
    expect(result.ok).toBe(false);
  });

  it('rejects edits that change nothing', () => {
    const result = check([{ file: 'pages/home.page.ts', find: 'HomePage', replace: 'HomePage' }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/changed nothing/);
  });
});

describe('renderElements', () => {
  it('lists only verified-unique selectors, since they are the model’s whole menu', () => {
    const rendered = renderElements(MODEL, 40);
    expect(rendered).toContain('el-login');
    expect(rendered).toContain(`this.page.locator('[data-test="login"]')`);
    expect(rendered).not.toContain('Sign in');
  });
});

const FAILING: TestResult = {
  title: 'signs in',
  file: 'tests/login.spec.ts',
  status: 'failed',
  failureClass: 'assertion-mismatch',
  errorExcerpt: 'Expected: "Welcome"\nReceived: "Error"',
  repairAttempts: 0,
};

function fake(response: unknown): FakeProvider {
  return new FakeProvider({ responder: () => ({ text: JSON.stringify(response) }) });
}

describe('proposeRepair', () => {
  const base = { test: FAILING, model: MODEL, modelId: 'test-model', tokenBudget: 30_000 };

  it('returns a validated patch the loop can apply', async () => {
    const result = await proposeRepair({
      ...base,
      files: files(),
      provider: fake({
        diagnosis: 'the locator moved',
        edits: [
          {
            file: 'pages/home.page.ts',
            find: `this.page.locator('[data-test="login"]')`,
            replace: `this.page.getByRole('button', { name: 'Login', exact: true })`,
          },
        ],
      }),
    });
    expect(result.applied?.files).toHaveLength(1);
    expect(result.rejected).toBeUndefined();
  });

  it('reports the reason when a proposal breaks a rule, instead of applying it', async () => {
    const result = await proposeRepair({
      ...base,
      files: files(),
      provider: fake({
        diagnosis: 'expectation is out of date',
        edits: [
          {
            file: 'tests/login.spec.ts',
            find: `expect(await page.title()).toBe('Welcome');`,
            replace: `expect(await page.title()).toBe('Error');`,
          },
        ],
      }),
    });
    expect(result.applied).toBeUndefined();
    expect(result.rejected).toMatch(/deletes what the test was checking/);
  });

  it('treats a declining model as a result, not an error', async () => {
    const result = await proposeRepair({
      ...base,
      files: files(),
      provider: fake({ diagnosis: 'the application looks wrong, not the test', edits: [] }),
    });
    expect(result.applied).toBeUndefined();
    expect(result.rejected).toMatch(/the application looks wrong/);
  });

  it('reports rather than throws when the model returns an unusable shape', async () => {
    // What the real provider does after its own retries are spent. A model that
    // cannot produce the right shape is a repair that did not happen, not a
    // crash that loses the rest of the run.
    const badShape: LLMProvider = {
      complete: () => Promise.reject(new Error('unused')),
      chat: () => Promise.reject(new Error('unused')),
      structured: () =>
        Promise.reject(new StructuredOutputError('Model output failed schema validation.')),
    };
    const result = await proposeRepair({ ...base, files: files(), provider: badShape });
    expect(result.applied).toBeUndefined();
    expect(result.rejected).toMatch(/did not return a usable repair proposal/);
  });

  it('lets a provider failure through, because it is not a repair outcome', async () => {
    // An expired key or a rate limit must not be reported as "the model had no
    // repair to offer" — that would hide the real problem behind a plausible
    // one. The runner catches it and keeps the rest of the run report.
    const broke: LLMProvider = {
      complete: () => Promise.reject(new Error('unused')),
      chat: () => Promise.reject(new Error('unused')),
      structured: () => Promise.reject(new ProviderError('401 unauthorized')),
    };
    await expect(proposeRepair({ ...base, files: files(), provider: broke })).rejects.toThrow(
      /401/,
    );
  });
});
