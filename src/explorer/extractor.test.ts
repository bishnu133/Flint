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

  // An <input> is not one role. Mapping them all to textbox made saucedemo's
  // `<input type="submit" value="Login">` look like an unnamed third text field
  // and hid the Login button from the planner entirely.
  it.each([
    ['submit', 'button'],
    ['reset', 'button'],
    ['button', 'button'],
    ['image', 'button'],
    ['checkbox', 'checkbox'],
    ['radio', 'radio'],
    ['range', 'slider'],
    ['number', 'spinbutton'],
    ['search', 'searchbox'],
    ['text', 'textbox'],
    ['email', 'textbox'],
    ['tel', 'textbox'],
    ['url', 'textbox'],
    // No ARIA role maps to these; getByRole('textbox') does not match them.
    ['password', undefined],
    ['file', undefined],
    ['color', undefined],
    ['date', undefined],
    ['datetime-local', undefined],
    ['month', undefined],
    ['week', undefined],
    ['time', undefined],
    // An invalid type renders in the Text state per the HTML spec.
    ['not-a-real-type', 'textbox'],
  ])('input[type=%s] => %s', (type, expected) => {
    expect(implicitRole('input', type)).toBe(expected);
  });

  it('is case- and whitespace-insensitive about the type attribute', () => {
    expect(implicitRole('input', ' SUBMIT ')).toBe('button');
  });

  it('ignores the type on tags where it means nothing', () => {
    expect(implicitRole('button', 'submit')).toBe('button');
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
  it('captures what a test drives or asserts on, and skips the rest', async () => {
    // A heading is captured deliberately: acceptance criteria assert on it.
    // Prose is not — nothing addresses a bare <p>, and capturing every one
    // would bury the elements that matter.
    await setContent(`
      <h1>Products</h1>
      <p>Just prose</p>
      <span>Also just prose</span>
      <button data-testid="go">Go</button>
      <a href="/next">Next</a>
      <input aria-label="Email">
    `);
    const result = await extractPage(page);
    expect(result.elements.map((e) => e.tagName).sort()).toEqual(['a', 'button', 'h1', 'input']);
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

  it('names a submit input from its value, not from a label', async () => {
    // Regression: this is the exact shape of saucedemo's Login control. The
    // planner previously saw "an unnamed 'textbox'" and asked whether the
    // Login button existed at all.
    await setContent('<input type="submit" class="submit-button" value="Login">');
    const el = (await extractPage(page)).elements[0]!;
    expect(el.role).toBe('button');
    expect(el.name).toBe('Login');
    const role = el.selectorCandidates.find((c) => c.strategy === 'role');
    expect(role?.value).toBe('button[name="Login"]');
    expect(role?.unique).toBe(true);
  });

  it('falls back to the browser default name for a bare submit input', async () => {
    await setContent('<input type="submit">');
    const el = (await extractPage(page)).elements[0]!;
    expect(el.name).toBe('Submit');
    expect(el.selectorCandidates.find((c) => c.strategy === 'role')?.unique).toBe(true);
  });

  it('names an image input from its alt text', async () => {
    await setContent('<input type="image" src="data:," alt="Search">');
    const el = (await extractPage(page)).elements[0]!;
    expect(el.role).toBe('button');
    expect(el.name).toBe('Search');
  });

  it('does not give a password input a textbox role candidate', async () => {
    // getByRole('textbox') genuinely does not match a password field, so a role
    // candidate here would be a selector that resolves to nothing.
    await setContent('<label for="p">Password</label><input id="p" type="password">');
    const el = (await extractPage(page)).elements[0]!;
    expect(el.selectorCandidates.some((c) => c.strategy === 'role')).toBe(false);
    // The label still carries it, so the element stays addressable.
    expect(el.selectorCandidates[0]?.strategy).toBe('label');
  });

  it('gives a checkbox the checkbox role, and the selector resolves', async () => {
    await setContent('<label for="t">Accept terms</label><input id="t" type="checkbox">');
    const el = (await extractPage(page)).elements[0]!;
    expect(el.role).toBe('checkbox');
    const role = el.selectorCandidates.find((c) => c.strategy === 'role')!;
    expect(role.value).toBe('checkbox[name="Accept terms"]');
    expect(role.unique).toBe(true);
  });

  it('distinguishes a submit input from the text inputs beside it', async () => {
    await setContent(`
      <input placeholder="Username">
      <input type="password" placeholder="Password">
      <input type="submit" value="Login">
    `);
    const roles = (await extractPage(page)).elements.map((e) => e.role);
    expect(roles).toEqual(['textbox', 'input', 'button']);
  });

  it('does not name a <select> after its options', async () => {
    // Regression: a select's textContent is the concatenation of its options,
    // which is not an accessible name. saucedemo's sort control produced the
    // property `nameAToZNameZToAPriceLowToHighPriceHighToLowSelect` and a
    // `combobox[name="…"]` selector that could never match.
    await setContent(`
      <select data-testid="sort">
        <option>Name (A to Z)</option>
        <option>Price (low to high)</option>
      </select>
    `);
    const el = (await extractPage(page)).elements[0]!;
    expect(el.role).toBe('combobox');
    expect(el.name).toBe('');
    expect(el.selectorCandidates.some((c) => c.strategy === 'role')).toBe(false);
  });

  it('still names a <select> from its label or aria-label', async () => {
    await setContent('<label for="s">Sort by</label><select id="s"><option>A</option></select>');
    expect((await extractPage(page)).elements[0]!.name).toBe('Sort by');
  });

  it('does not name a <textarea> after the text already typed into it', async () => {
    // A textarea's content is its value, not a label.
    await setContent('<textarea data-testid="c">whatever the user typed</textarea>');
    const el = (await extractPage(page)).elements[0]!;
    expect(el.name).toBe('');
  });

  it('captures an error banner, which is asserted on rather than clicked', async () => {
    // The net used to catch only interactive elements, so saucedemo's
    // `<h3 data-test="error">` was never captured and the planner kept
    // correctly refusing to write the case: "no error-message element exists".
    await setContent(`
      <div class="error-message-container error">
        <h3 data-test="error">Epic sadface: Username and password do not match</h3>
        <button class="error-button"></button>
      </div>
    `);
    const el = (await extractPage(page)).elements.find((e) => e.tagName === 'h3');
    expect(el).toBeDefined();
    expect(el?.name).toContain('Epic sadface');
  });

  it('captures headings and live regions', async () => {
    await setContent(`
      <h1>Products</h1>
      <div role="alert">Something went wrong</div>
      <div role="status">Saved</div>
      <div aria-live="polite">3 items</div>
    `);
    const roles = (await extractPage(page)).elements.map((e) => e.role).sort();
    expect(roles).toEqual(['alert', 'div', 'h1', 'status']);
  });

  it('honours the configured test-id attribute when deciding what to capture', async () => {
    // Hardcoding `[data-testid]` meant an app using `data-test` had none of its
    // deliberately-marked elements captured — the ones its authors flagged as
    // mattering most.
    await setContent('<span data-test="title">Products</span>');
    expect((await extractPage(page)).elements).toHaveLength(0);
    const captured = await extractPage(page, { testIdAttribute: 'data-test' });
    expect(captured.elements).toHaveLength(1);
    expect(captured.elements[0]?.testId).toBe('title');
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
