import { describe, it, expect } from 'vitest';
import { matchPages, specKeywords } from './page-matcher.js';
import { parseFeatureSpec } from './feature-spec.js';
import type { Element, ScreenModel } from '../schemas/screen-model.js';

/**
 * The matcher decides what the planner can see, and therefore what it can
 * plan. Selecting nothing relevant produces spurious `blocked` cases; selecting
 * everything wastes the token budget on pages the feature is not about.
 */

function element(id: string, name: string): Element {
  return {
    id,
    role: 'button',
    name,
    tagName: 'button',
    boundingBox: { x: 0, y: 0, width: 1, height: 1 },
    states: { visible: true, enabled: true },
    selectorCandidates: [],
  };
}

/** Mirrors the operator's saucedemo model: the login screen lives at `/`. */
const SAUCEDEMO: ScreenModel = {
  version: '1',
  baseUrl: 'https://www.saucedemo.com',
  capturedAt: '2026-01-01T00:00:00.000Z',
  pages: [
    page('/', 'Swag Labs', [element('el-user', 'Username'), element('el-login', 'Login')]),
    page('/inventory.html', 'Products', [element('el-add', 'Add to cart')]),
    page('/cart.html', 'Your Cart', [element('el-checkout', 'Checkout')]),
    page('/inventory-item.html', 'Item', [element('el-back', 'Back to products')]),
  ],
};

function page(urlPattern: string, title: string, elements: Element[]) {
  return {
    id: `page${urlPattern}`,
    url: `https://www.saucedemo.com${urlPattern === '/' ? '' : urlPattern}`,
    urlPattern,
    title,
    reachedVia: { kind: 'link' as const, href: urlPattern },
    navTargets: [],
    capturedAt: '2026-01-01T00:00:00.000Z',
    elements,
  };
}

function spec(frontmatter: string, body = '') {
  return parseFeatureSpec(`---\n${frontmatter}\n---\n\n${body}`, 'spec.md');
}

describe('matchPages — pages: hints', () => {
  it('treats a root hint as the root page only', () => {
    // Every path contains a slash, so a naive substring match on "/" would
    // select the whole model and report every page as an explicit hint.
    const matches = matchPages(spec("id: login\ntitle: Login\npages: ['/']"), SAUCEDEMO);
    expect(matches.map((m) => m.page.urlPattern)).toEqual(['/']);
    expect(matches[0]!.reason).toBe('pages-hint');
  });

  it('ranks the hinted page first', () => {
    // Other pages may still appear on keyword overlap — /inventory.html has an
    // "Add to cart" button — but the explicit hint must outrank them.
    const matches = matchPages(spec("id: cart\ntitle: Cart\npages: ['/cart.html']"), SAUCEDEMO);
    expect(matches[0]!.page.urlPattern).toBe('/cart.html');
    expect(matches[0]!.reason).toBe('pages-hint');
    expect(matches.filter((m) => m.reason === 'pages-hint')).toHaveLength(1);
  });

  it('matches a path prefix', () => {
    const matches = matchPages(spec("id: cart\ntitle: Cart\npages: ['/cart']"), SAUCEDEMO);
    expect(matches.map((m) => m.page.urlPattern)).toContain('/cart.html');
  });

  it('ignores a trailing slash on the hint', () => {
    const matches = matchPages(spec("id: inv\ntitle: Inv\npages: ['/inventory.html/']"), SAUCEDEMO);
    expect(matches.map((m) => m.page.urlPattern)).toContain('/inventory.html');
  });

  it('matches on page title too', () => {
    const matches = matchPages(spec("id: p\ntitle: Products\npages: ['Swag Labs']"), SAUCEDEMO);
    expect(matches[0]!.page.urlPattern).toBe('/');
  });

  it('accepts several hints', () => {
    const matches = matchPages(
      spec("id: journey\ntitle: Journey\npages: ['/', '/cart.html']"),
      SAUCEDEMO,
    );
    expect(matches.map((m) => m.page.urlPattern).sort()).toEqual(['/', '/cart.html']);
  });
});

describe('matchPages — fallbacks', () => {
  it('falls back to keyword overlap when there are no hints', () => {
    const matches = matchPages(spec('id: cart\ntitle: Checkout the cart'), SAUCEDEMO);
    expect(matches[0]!.reason).toBe('keyword');
    expect(matches[0]!.page.urlPattern).toBe('/cart.html');
  });

  it('offers the whole model, flagged, when nothing matches at all', () => {
    // A planner with the wrong pages can emit `blocked`; one with no pages can
    // only fail. The `only-page` reason is what tells the prompt to say so.
    const matches = matchPages(spec('id: billing\ntitle: Invoices and VAT'), SAUCEDEMO);
    expect(matches.length).toBe(SAUCEDEMO.pages.length);
    expect(matches.every((m) => m.reason === 'only-page')).toBe(true);
  });

  it('returns nothing for an empty model rather than inventing a page', () => {
    expect(matchPages(spec('id: a\ntitle: A'), { ...SAUCEDEMO, pages: [] })).toEqual([]);
  });

  it('prefers an explicit hint over a keyword match', () => {
    const matches = matchPages(
      spec("id: cart\ntitle: Checkout the cart\npages: ['/inventory.html']"),
      SAUCEDEMO,
    );
    expect(matches[0]!.page.urlPattern).toBe('/inventory.html');
    expect(matches[0]!.reason).toBe('pages-hint');
  });

  it('matches a flow-reached page from a flows: hint', () => {
    const withFlow: ScreenModel = {
      ...SAUCEDEMO,
      pages: [
        {
          ...page('/cart.html', 'Cart', [element('el-remove', 'Remove')]),
          reachedVia: { kind: 'flow', flowId: 'populated-cart', step: 0 },
        },
      ],
    };
    const matches = matchPages(spec("id: cart\ntitle: Cart\nflows: ['populated-cart']"), withFlow);
    expect(matches[0]!.reason).toBe('flow-hint');
  });

  it('honours the limit', () => {
    const matches = matchPages(spec('id: billing\ntitle: Invoices'), SAUCEDEMO, { limit: 2 });
    expect(matches).toHaveLength(2);
  });

  it('is deterministic — equal scores break ties on page id', () => {
    const a = matchPages(spec('id: billing\ntitle: Invoices'), SAUCEDEMO);
    const b = matchPages(spec('id: billing\ntitle: Invoices'), SAUCEDEMO);
    expect(b.map((m) => m.page.id)).toEqual(a.map((m) => m.page.id));
  });
});

describe('specKeywords', () => {
  it('drops stop words and short tokens', () => {
    const words = specKeywords(spec('id: a\ntitle: The user can add an item to the cart'));
    expect(words.has('item')).toBe(true);
    expect(words.has('cart')).toBe(true);
    expect(words.has('the')).toBe(false);
    expect(words.has('can')).toBe(false);
  });

  it('includes words from acceptance criteria and the body', () => {
    const words = specKeywords(
      spec('id: a\ntitle: A\nacceptanceCriteria:\n  - checkout completes', 'inventory prose'),
    );
    expect(words.has('checkout')).toBe(true);
    expect(words.has('inventory')).toBe(true);
  });
});
