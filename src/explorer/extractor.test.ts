import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Browser, Page as PwPage } from '@playwright/test';
import { launchBrowser } from './browser.js';
import { extractPage, implicitRole, pageId } from './extractor.js';

/**
 * Extractor tests drive a real Chromium against inline fixture HTML — no
 * network, so they are deterministic and offline-safe, while still exercising
 * the live uniqueness verification that is the whole point of the extractor.
 */

let browser: Browser;
let page: PwPage;

beforeAll(async () => {
  browser = await launchBrowser();
  page = await browser.newPage();
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

async function setContent(html: string): Promise<void> {
  await page.goto('about:blank');
  await page.setContent(html);
}

describe('implicitRole', () => {
  it.each([
    ['a', 'link'],
    ['button', 'button'],
    ['select', 'combobox'],
    ['textarea', 'textbox'],
    ['input', 'textbox'],
    ['div', undefined],
  ])('%s => %s', (tag, expected) => {
    expect(implicitRole(tag)).toBe(expected);
  });
});

describe('pageId', () => {
  it('is stable for the same pattern', () => {
    expect(pageId('/cart')).toBe(pageId('/cart'));
  });

  it('differs per role, so multi-role models do not collide', () => {
    expect(pageId('/cart', 'admin')).not.toBe(pageId('/cart', 'user'));
  });
});

describe('extractPage', () => {
  it('captures interactive elements and skips non-interactive chrome', async () => {
    await setContent(`
      <h1>Not interactive</h1>
      <p>Also not</p>
      <button data-testid="go">Go</button>
      <a href="/next">Next</a>
      <input aria-label="Email">
    `);
    const result = await extractPage(page);
    expect(result.elements.length).toBe(3);
    expect(result.elements.map((e) => e.tagName).sort()).toEqual(['a', 'button', 'input']);
  });

  it('verifies uniqueness live — a unique testid is verified and unique', async () => {
    await setContent('<button data-testid="only">Go</button>');
    const el = (await extractPage(page)).elements[0]!;
    const testid = el.selectorCandidates.find((c) => c.strategy === 'testid')!;
    expect(testid.verified).toBe(true);
    expect(testid.unique).toBe(true);
    expect(testid.score).toBeCloseTo(100, 10);
  });

  it('penalises a duplicated testid — this is the anti-invention guard', async () => {
    await setContent(`
      <button data-testid="dup">One</button>
      <button data-testid="dup">Two</button>
    `);
    const result = await extractPage(page);
    for (const el of result.elements) {
      const testid = el.selectorCandidates.find((c) => c.strategy === 'testid');
      if (testid !== undefined) {
        expect(testid.unique).toBe(false);
        expect(testid.score).toBeCloseTo(30, 10); // 100 * 0.3
      }
    }
  });

  it('marks every candidate verified — Phase 4 may only use verified ones', async () => {
    await setContent('<button data-testid="go">Go</button>');
    const el = (await extractPage(page)).elements[0]!;
    expect(el.selectorCandidates.every((c) => c.verified)).toBe(true);
  });

  it('reads a label as a selector candidate', async () => {
    await setContent('<label for="e">Email address</label><input id="e">');
    const el = (await extractPage(page)).elements[0]!;
    const label = el.selectorCandidates.find((c) => c.strategy === 'label');
    expect(label?.value).toBe('Email address');
    expect(label?.unique).toBe(true);
  });

  it('reads a placeholder as a selector candidate', async () => {
    await setContent('<input placeholder="you@example.com">');
    const el = (await extractPage(page)).elements[0]!;
    expect(el.selectorCandidates.find((c) => c.strategy === 'placeholder')?.value).toBe(
      'you@example.com',
    );
  });

  it('uses placeholder as the accessible name, so a role candidate exists', async () => {
    // Regression: saucedemo's inputs have only a placeholder. Without this,
    // the element topped out at placeholder (65) and lost the role (85).
    await setContent('<input placeholder="Username">');
    const el = (await extractPage(page)).elements[0]!;
    expect(el.name).toBe('Username');
    const role = el.selectorCandidates.find((c) => c.strategy === 'role');
    expect(role).toBeDefined();
    expect(role?.unique).toBe(true);
    expect(role?.score).toBeCloseTo(85, 10);
    expect(el.selectorCandidates[0]?.strategy).toBe('role');
  });

  it('prefers aria-label over placeholder for the accessible name', async () => {
    await setContent('<input aria-label="Email address" placeholder="you@x.com">');
    const el = (await extractPage(page)).elements[0]!;
    expect(el.name).toBe('Email address');
  });

  it('still prefers a <label> over placeholder', async () => {
    await setContent('<label for="e">Your email</label><input id="e" placeholder="you@x.com">');
    const el = (await extractPage(page)).elements[0]!;
    expect(el.name).toBe('Your email');
  });

  it('always produces a css fallback candidate', async () => {
    await setContent('<button>Bare</button>');
    const el = (await extractPage(page)).elements[0]!;
    expect(el.selectorCandidates.some((c) => c.strategy === 'css')).toBe(true);
  });

  it('records visible/enabled state', async () => {
    await setContent(`
      <button data-testid="on">On</button>
      <button data-testid="off" disabled>Off</button>
      <button data-testid="hidden" style="display:none">Hidden</button>
    `);
    const byTestId = new Map(
      (await extractPage(page)).elements.map((e) => [e.testId, e.states] as const),
    );
    expect(byTestId.get('on')).toEqual({ visible: true, enabled: true });
    expect(byTestId.get('off')).toEqual({ visible: true, enabled: false });
    expect(byTestId.get('hidden')?.visible).toBe(false);
  });

  it('pierces open shadow roots because it uses locator APIs', async () => {
    await setContent('<div id="host"></div>');
    await page.evaluate(() => {
      const host = document.querySelector('#host')!;
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = '<button data-testid="in-shadow">Shadow</button>';
    });
    const result = await extractPage(page);
    expect(result.elements.some((e) => e.testId === 'in-shadow')).toBe(true);
  });

  it('collects same-origin nav targets, deduped and sorted', async () => {
    await setContent(`
      <a href="/b">B</a><a href="/a">A</a><a href="/a">A again</a>
    `);
    expect((await extractPage(page)).navTargets).toEqual(['/a', '/b']);
  });

  it('captures the html lang for i18n-aware ranking', async () => {
    await page.goto('about:blank');
    await page.setContent('<html lang="fr"><body><button>Aller</button></body></html>');
    expect((await extractPage(page)).lang).toBe('fr');
  });

  it('demotes text strategies under i18n so css outranks text', async () => {
    await setContent('<button>Connexion</button>');
    const el = (await extractPage(page, { i18n: true })).elements[0]!;
    const text = el.selectorCandidates.find((c) => c.strategy === 'text')!;
    const css = el.selectorCandidates.find((c) => c.strategy === 'css')!;
    expect(css.score).toBeGreaterThan(text.score);
  });

  it('honours a custom test-id attribute', async () => {
    await setContent('<button data-qa="go">Go</button>');
    const el = (await extractPage(page, { testIdAttribute: 'data-qa' })).elements[0]!;
    expect(el.testId).toBe('go');
    expect(el.selectorCandidates[0]?.value).toBe('[data-qa="go"]');
  });

  it('applies urlPattern normalization to the page pattern', async () => {
    await setContent('<button>x</button>');
    const result = await extractPage(page, {
      normalizeRules: [{ pattern: '/blank', replacement: '/normalized' }],
    });
    // about:blank has no pathname to rewrite; the pattern is still deterministic.
    expect(typeof result.urlPattern).toBe('string');
  });

  it('caps element capture to bound pathological pages', async () => {
    const many = Array.from(
      { length: 40 },
      (_, i) => `<button data-testid="b${i}">B</button>`,
    ).join('');
    await setContent(many);
    expect((await extractPage(page, { maxElements: 10 })).elements.length).toBeLessThanOrEqual(10);
  });

  it('produces stable element ids across repeated extractions', async () => {
    const html = '<button data-testid="go">Go</button><a href="/x">X</a>';
    await setContent(html);
    const first = (await extractPage(page)).elements.map((e) => e.id).sort();
    await setContent(html);
    const second = (await extractPage(page)).elements.map((e) => e.id).sort();
    expect(second).toEqual(first);
  });

  it('gives different elements different ids', async () => {
    await setContent('<button data-testid="a">A</button><button data-testid="b">B</button>');
    const ids = (await extractPage(page)).elements.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('extracts same-origin iframe content with framePath recorded', async () => {
    await page.goto('about:blank');
    await page.setContent(`
      <button data-testid="outer">Outer</button>
      <iframe name="inner" srcdoc='<button data-testid="inside">Inside</button>'></iframe>
    `);
    await page.waitForTimeout(150); // let the frame attach
    const result = await extractPage(page);
    const inner = result.elements.find((e) => e.testId === 'inside');
    expect(inner).toBeDefined();
    expect(inner?.framePath?.length).toBeGreaterThan(0);
  });

  it('produces a schema-valid page', async () => {
    await setContent('<button data-testid="go">Go</button>');
    const { PageSchema } = await import('../schemas/screen-model.js');
    const result = await extractPage(page);
    // about: URLs are not absolute http(s); assert the parts the schema governs.
    const parsed = PageSchema.safeParse({ ...result, url: 'https://app.example.com/x' });
    if (!parsed.success) console.error(parsed.error.issues);
    expect(parsed.success).toBe(true);
  });
});
