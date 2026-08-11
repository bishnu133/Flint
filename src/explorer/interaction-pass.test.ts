import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { launchBrowser, createContext } from './browser.js';
import { extractPage } from './extractor.js';
import { isDangerous, runInteractionPass } from './interaction-pass.js';
import { waitForDomStable, recordRoutes } from './wait.js';

/**
 * The interaction pass is exercised against a fixture with a real toggling
 * menu, a real modal, a denylisted trigger and a link wearing a popup
 * attribute — the four shapes that decide whether the pass is safe.
 */

/**
 * The panels are *rendered on demand*, not merely hidden — that is the case the
 * pass exists for. A `hidden` panel is still in the DOM, so the first snapshot
 * would already see it and there would be nothing to reveal.
 */
const MENU_PAGE = `<html lang="en"><body>
  <h1>App</h1>
  <button id="acct" aria-haspopup="menu" aria-expanded="false">Account</button>
  <button id="danger" aria-haspopup="dialog" aria-expanded="false">Delete account</button>
  <a href="/settings" id="fake-popup" aria-haspopup="true">Settings link</a>
  <div id="portal"></div>

  <script>
    function wire(triggerId, panelId, html) {
      var t = document.getElementById(triggerId);
      t.addEventListener('click', function () {
        var portal = document.getElementById('portal');
        var existing = document.getElementById(panelId);
        if (existing !== null) {
          existing.remove();
          t.setAttribute('aria-expanded', 'false');
          return;
        }
        var panel = document.createElement('div');
        panel.id = panelId;
        panel.innerHTML = html;
        portal.appendChild(panel);
        t.setAttribute('aria-expanded', 'true');
      });
    }
    wire('acct', 'acct-menu',
      '<a href="/settings" data-testid="menu-settings">Settings</a>' +
      '<button data-testid="menu-profile">Profile</button>');
    wire('danger', 'danger-modal',
      '<button data-testid="confirm-delete">Confirm</button>');
  </script>
</body></html>`;

const SETTINGS_PAGE = `<html lang="en"><body><h1>Settings</h1></body></html>`;

let server: Server;
let baseUrl: string;
let browser: Browser;
let context: BrowserContext;
let page: Page;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(path === '/settings' ? SETTINGS_PAGE : MENU_PAGE);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await launchBrowser({ proxyServer: '' });
  context = await createContext(browser);
  page = await context.newPage();
}, 120_000);

afterAll(async () => {
  await context?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await new Promise<void>((r) => server?.close(() => r()));
});

/** Fresh page + first-pass extraction, as the crawler does it. */
async function firstPass() {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await waitForDomStable(page);
  const captured = await extractPage(page);
  return captured.elements;
}

describe('isDangerous', () => {
  const patterns = ['logout', 'delete', 'submit', 'pay'];
  const cases: Array<[string, boolean]> = [
    ['Delete account', true],
    ['DELETE', true],
    ['Log out', false], // "log out" ≠ "logout" — substring match is literal
    ['Logout', true],
    ['Pay now', true],
    ['Account', false],
    ['', false],
  ];
  for (const [text, expected] of cases) {
    it(`${expected ? 'blocks' : 'allows'} ${JSON.stringify(text)}`, () => {
      expect(isDangerous(text, patterns)).toBe(expected);
    });
  }

  it('never blocks when no patterns are configured', () => {
    expect(isDangerous('Delete everything', [])).toBe(false);
  });

  it('ignores an empty pattern rather than matching everything', () => {
    expect(isDangerous('Account', [''])).toBe(false);
  });
});

describe('runInteractionPass', () => {
  it('reveals menu items that do not exist until the menu is opened', async () => {
    const before = await firstPass();
    const result = await runInteractionPass(page, before, {
      dangerousActionPatterns: ['delete'],
    });
    const testIds = result.revealed.map((e) => e.testId);
    expect(testIds).toContain('menu-settings');
    expect(testIds).toContain('menu-profile');
  }, 90_000);

  it('never clicks a trigger on the dangerous-action denylist', async () => {
    const before = await firstPass();
    const result = await runInteractionPass(page, before, {
      dangerousActionPatterns: ['delete'],
    });
    const danger = result.outcomes.find((o) => o.opener === 'Delete account');
    expect(danger?.skipped).toBe('dangerous');
    // The modal's contents must never reach the model.
    expect(result.revealed.map((e) => e.testId)).not.toContain('confirm-delete');
  }, 90_000);

  it('opens a modal when its trigger is not denylisted', async () => {
    const before = await firstPass();
    const result = await runInteractionPass(page, before, { dangerousActionPatterns: [] });
    expect(result.revealed.map((e) => e.testId)).toContain('confirm-delete');
  }, 90_000);

  it('restores the page when a trigger turns out to be a link', async () => {
    const before = await firstPass();
    const result = await runInteractionPass(page, before, { dangerousActionPatterns: [] });
    const link = result.outcomes.find((o) => o.opener === 'Settings link');
    expect(link?.skipped).toBe('navigated');
    // Back on the original page, ready for the crawler to carry on.
    expect(page.url().replace(/\/$/, '')).toBe(baseUrl);
  }, 90_000);

  it('closes what it opened — the page is back to baseline afterwards', async () => {
    const before = await firstPass();
    await runInteractionPass(page, before, { dangerousActionPatterns: [] });
    expect(await page.locator('#acct-menu').isVisible()).toBe(false);
    expect(await page.locator('#acct').getAttribute('aria-expanded')).toBe('false');
  }, 90_000);

  it('does not re-report elements the first pass already captured', async () => {
    const before = await firstPass();
    const result = await runInteractionPass(page, before, { dangerousActionPatterns: [] });
    const beforeIds = new Set(before.map((e) => e.id));
    for (const element of result.revealed) expect(beforeIds.has(element.id)).toBe(false);
  }, 90_000);

  it('respects maxOpeners', async () => {
    const before = await firstPass();
    const result = await runInteractionPass(page, before, {
      dangerousActionPatterns: [],
      maxOpeners: 1,
    });
    expect(result.outcomes).toHaveLength(1);
  }, 90_000);

  it('stamps revealed elements with the trigger that reveals them', async () => {
    const before = await firstPass();
    const result = await runInteractionPass(page, before, { dangerousActionPatterns: [] });

    const acct = before.find((e) => e.domId === 'acct')!;
    const settings = result.revealed.find((e) => e.testId === 'menu-settings')!;

    // The Emitter needs this to click "Account" before touching "Settings".
    expect(settings.provenance).toEqual({ kind: 'revealed', openerElementId: acct.id });
    // And the id must resolve to a real element in the model, not a dangle.
    expect(before.some((e) => e.id === acct.id)).toBe(true);
  }, 90_000);

  it('reports the opener element id on the outcome', async () => {
    const before = await firstPass();
    const result = await runInteractionPass(page, before, { dangerousActionPatterns: [] });
    const acct = before.find((e) => e.domId === 'acct')!;
    const outcome = result.outcomes.find((o) => o.opener === 'Account')!;
    expect(outcome.openerElementId).toBe(acct.id);
  }, 90_000);

  it('skips a trigger that is not itself a captured element', async () => {
    // Nothing downstream could click it, so whatever it reveals is unreachable.
    const result = await runInteractionPass(page, [], { dangerousActionPatterns: [] });
    expect(result.revealed).toEqual([]);
    expect(result.outcomes.every((o) => o.skipped === 'opener-not-in-model')).toBe(true);
  }, 90_000);

  it('is deterministic — two passes over an unchanged page reveal the same ids', async () => {
    const a = await runInteractionPass(page, await firstPass(), { dangerousActionPatterns: [] });
    const b = await runInteractionPass(page, await firstPass(), { dangerousActionPatterns: [] });
    expect(b.revealed.map((e) => e.id)).toEqual(a.revealed.map((e) => e.id));
  }, 120_000);
});

describe('waitForDomStable', () => {
  it('returns stable for a page that is not changing', async () => {
    await page.goto(`${baseUrl}/settings`, { waitUntil: 'domcontentloaded' });
    const result = await waitForDomStable(page, { timeoutMs: 3000 });
    expect(result.stable).toBe(true);
    expect(result.samples).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it('gives up rather than hanging on a page that never settles', async () => {
    await page.goto(`${baseUrl}/settings`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      setInterval(() => document.body.appendChild(document.createElement('span')), 20);
    });
    const result = await waitForDomStable(page, { timeoutMs: 800, intervalMs: 50 });
    expect(result.stable).toBe(false);
    expect(result.waitedMs).toBeLessThan(3000);
  }, 60_000);

  it('waits for content that arrives after load', async () => {
    await page.goto(`${baseUrl}/settings`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      setTimeout(() => {
        const el = document.createElement('p');
        el.id = 'late';
        el.textContent = 'late content';
        document.body.appendChild(el);
      }, 250);
    });
    await waitForDomStable(page, { timeoutMs: 4000 });
    expect(await page.locator('#late').count()).toBe(1);
  }, 60_000);
});

describe('recordRoutes', () => {
  it('reports no change when the page stays put', async () => {
    await page.goto(`${baseUrl}/settings`, { waitUntil: 'domcontentloaded' });
    const routes = recordRoutes(page);
    await waitForDomStable(page, { timeoutMs: 500 });
    expect(routes.changed()).toBe(false);
    routes.stop();
  }, 60_000);

  it('detects a client-side route change made through the history API', async () => {
    await page.goto(`${baseUrl}/settings`, { waitUntil: 'domcontentloaded' });
    const routes = recordRoutes(page);
    await page.evaluate(() => history.pushState({}, '', '/settings/spa-route'));
    expect(routes.changed()).toBe(true);
    routes.stop();
  }, 60_000);

  it('detects a real navigation', async () => {
    await page.goto(`${baseUrl}/settings`, { waitUntil: 'domcontentloaded' });
    const routes = recordRoutes(page);
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    expect(routes.changed()).toBe(true);
    expect(routes.urls().length).toBeGreaterThan(0);
    routes.stop();
  }, 60_000);
});
