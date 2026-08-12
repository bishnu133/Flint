import { describe, it, expect } from 'vitest';
import {
  applySwap,
  elementForSelector,
  failingSelector,
  nextSelector,
  swapSelector,
} from './selector-retry.js';
import type { Element, ScreenModel, SelectorCandidate } from '../schemas/screen-model.js';

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

function element(candidates: SelectorCandidate[], over: Partial<Element> = {}): Element {
  return {
    id: 'el-login',
    role: 'button',
    name: 'Login',
    tagName: 'button',
    boundingBox: { x: 0, y: 0, width: 10, height: 10 },
    states: { visible: true, enabled: true },
    selectorCandidates: candidates,
    ...over,
  };
}

function model(elements: Element[]): ScreenModel {
  return {
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
        elements,
      },
    ],
  };
}

describe('failingSelector', () => {
  it.each([
    [
      'a wait failure',
      'locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for locator(\'[data-test="gone"]\')',
      '[data-test="gone"]',
    ],
    [
      'an expect block',
      "Error: expect(locator).toBeVisible() failed\n\nLocator: locator('#error')\nExpected: visible",
      '#error',
    ],
    [
      'a strict mode violation',
      "strict mode violation: getByRole('button') resolved to 3 elements",
      "getByRole('button')",
    ],
  ])('reads the selector out of %s', (_label, error, expected) => {
    expect(failingSelector(error)).toBe(expected);
  });

  it('returns nothing rather than guessing when the error names no selector', () => {
    expect(failingSelector('Test timeout of 30000ms exceeded.')).toBeUndefined();
    expect(failingSelector(undefined)).toBeUndefined();
  });
});

describe('nextSelector', () => {
  it('offers the next verified-unique candidate in ranked order', () => {
    const el = element([
      candidate({ strategy: 'testid', value: '[data-test="login"]', score: 100 }),
      candidate({ strategy: 'role', value: 'button[name="Login"]', score: 85 }),
      candidate({ strategy: 'css', value: 'form > button', score: 30 }),
    ]);
    const result = nextSelector(el, ['[data-test="login"]']);
    expect(result?.next.strategy).toBe('role');
    expect(result?.previous?.value).toBe('[data-test="login"]');
    expect(result?.expression).toBe(
      "this.page.getByRole('button', { name: 'Login', exact: true })",
    );
  });

  it('never offers a candidate that was not verified unique', () => {
    // The same rule the Emitter follows: a non-unique selector is not a
    // fallback, it is a different way to fail.
    const el = element([
      candidate({ value: '[data-test="login"]' }),
      candidate({ strategy: 'css', value: 'button', score: 9, unique: false }),
      candidate({ strategy: 'text', value: 'Login', score: 55, verified: false }),
    ]);
    expect(nextSelector(el, ['[data-test="login"]'])).toBeUndefined();
  });

  it('never re-offers something already tried', () => {
    // Without this the loop would propose the selector that just failed and
    // burn its LOCKED two iterations achieving nothing.
    const el = element([
      candidate({ value: 'a' }),
      candidate({ strategy: 'role', value: 'button[name="Login"]', score: 85 }),
    ]);
    expect(nextSelector(el, ['a', 'button[name="Login"]'])).toBeUndefined();
  });

  it('gives up when the element has one candidate and it failed', () => {
    expect(nextSelector(element([candidate()]), ['[data-test="login"]'])).toBeUndefined();
  });
});

describe('elementForSelector', () => {
  it('finds the element by its stored candidate value', () => {
    const el = element([candidate({ value: '[data-test="gone"]' })]);
    expect(elementForSelector(model([el]), '[data-test="gone"]')?.id).toBe('el-login');
  });

  it('finds it by the rendered expression, which is what the error shows', () => {
    // The model stores `button[name="Login"]`; Playwright prints the
    // getByRole call. Matching only the stored form would miss every role
    // selector — the second most common strategy.
    const el = element([candidate({ strategy: 'role', value: 'button[name="Login"]', score: 85 })]);
    expect(elementForSelector(model([el]), "getByRole('button'")?.id).toBe('el-login');
  });

  it('returns nothing for a selector no element owns', () => {
    expect(elementForSelector(model([element([candidate()])]), '#nowhere')).toBeUndefined();
    expect(elementForSelector(model([element([candidate()])]), '  ')).toBeUndefined();
  });
});

describe('swapSelector / applySwap', () => {
  const source = `    this.loginButton = this.page.locator('[data-test="login"]');\n`;

  it('rewrites the locator line', () => {
    const swap = swapSelector(
      source,
      `this.page.locator('[data-test="login"]')`,
      `this.page.getByRole('button', { name: 'Login', exact: true })`,
    );
    expect(swap).toBeDefined();
    expect(applySwap(source, swap!)).toContain('getByRole');
    expect(applySwap(source, swap!)).not.toContain('data-test="login"');
  });

  it('refuses when the old expression is not in the file', () => {
    // The page object is not what we think it is; a blind edit would corrupt
    // it. Refusing hands the case to the LLM path with the full file in view.
    expect(swapSelector(source, `this.page.locator('#absent')`, 'x')).toBeUndefined();
  });

  it('refuses a no-op swap', () => {
    const same = `this.page.locator('[data-test="login"]')`;
    expect(swapSelector(source, same, same)).toBeUndefined();
  });
});
