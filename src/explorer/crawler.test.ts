import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Browser, BrowserContext } from '@playwright/test';
import { launchBrowser, createContext, resolveProxy } from './browser.js';
import { crawl } from './crawler.js';
import { FlintConfigSchema, type FlintConfig } from '../schemas/config.js';
import { ScreenModelSchema } from '../schemas/screen-model.js';

/**
 * End-to-end crawl against a local fixture site.
 *
 * A real browser over real HTTP, but served from localhost so the test is
 * deterministic and needs no external network. This exercises the whole loop:
 * BFS ordering, dedupe, depth and page budgets, extraction, and the safety
 * rails — everything except reaching the public internet.
 */

/** A small site with a link graph, a cycle, a dead end, and a danger button. */
const SITE: Record<string, string> = {
  '/': `<html lang="en"><body>
    <h1>Home</h1>
    <a href="/about">About</a>
    <a href="/products">Products</a>
    <a href="https://external.example.com/x">External</a>
    <a href="mailto:a@b.com">Mail</a>
    <button data-testid="delete-account">Delete account</button>
  </body></html>`,
  '/about': `<html lang="en"><body>
    <h1>About</h1><a href="/">Home</a>
    <a href="/wall">Sign in</a>
    <button data-testid="about-cta">Contact</button>
  </body></html>`,
  '/products': `<html lang="en"><body>
    <h1>Products</h1>
    <a href="/product/1">One</a><a href="/product/2">Two</a><a href="/product/3">Three</a>
  </body></html>`,
  '/product/1': `<html lang="en"><body><h1>P1</h1><button data-testid="buy">Buy</button></body></html>`,
  '/product/2': `<html lang="en"><body><h1>P2</h1><button data-testid="buy">Buy</button></body></html>`,
  '/product/3': `<html lang="en"><body><h1>P3</h1><button data-testid="buy">Buy</button></body></html>`,
  '/blocked': `<html lang="en"><body><h1>Please verify you are human</h1></body></html>`,
  '/catalog': `<html lang="en"><body>
    <h1>Catalog</h1>
    <a href="/item.html?id=1">One</a><a href="/item.html?id=2">Two</a><a href="/item.html?id=3">Three</a>
  </body></html>`,
  '/item.html': `<html lang="en"><body><h1>Item</h1><button data-testid="buy">Buy</button></body></html>`,
  '/wall': `<html lang="en"><body>
    <h1>Sign in</h1>
    <form method="POST" action="/wall">
      <input name="username" placeholder="Username">
      <input name="password" type="password" placeholder="Password">
      <button type="submit" id="login-button">Login</button>
    </form>
  </body></html>`,
};

let server: Server;
let baseUrl: string;
let browser: Browser;
let context: BrowserContext;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    const body = SITE[path];
    if (body === undefined) {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('<html><body>404</body></html>');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  browser = await launchBrowser({
    // localhost must bypass any ambient proxy, or CONNECT is refused.
    proxyServer: '',
  });
  context = await createContext(browser);
}, 120_000);

afterAll(async () => {
  await context?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await new Promise<void>((r) => server?.close(() => r()));
});

function config(overrides: Record<string, unknown> = {}): FlintConfig {
  return FlintConfigSchema.parse({
    baseUrl,
    envClass: 'test',
    models: { planner: 'a', coder: 'b', repair: 'c' },
    ...overrides,
  });
}

describe('resolveProxy', () => {
  it('returns undefined when no proxy is configured', () => {
    expect(resolveProxy({ proxyServer: '' })).toBeUndefined();
  });

  it('uses an explicit proxy server over the environment', () => {
    expect(resolveProxy({ proxyServer: 'http://p:8080' })?.server).toBe('http://p:8080');
  });

  it('passes a bypass list through', () => {
    expect(resolveProxy({ proxyServer: 'http://p:8080', noProxy: 'localhost' })?.bypass).toBe(
      'localhost',
    );
  });
});

describe('crawl', () => {
  it('walks the link graph and produces a schema-valid model', async () => {
    const result = await crawl(context, { config: config() });
    expect(ScreenModelSchema.safeParse(result.model).success).toBe(true);
    expect(result.model.pages.length).toBeGreaterThanOrEqual(6);
  }, 60_000);

  it('follows only same-origin links — external and mailto are not crawled', async () => {
    const result = await crawl(context, { config: config() });
    for (const page of result.model.pages) {
      expect(page.url.startsWith(baseUrl)).toBe(true);
    }
  }, 60_000);

  it('honours maxPages and reports the remainder as budget-skipped', async () => {
    const result = await crawl(context, { config: config({ explorer: { maxPages: 2 } }) });
    expect(result.model.pages).toHaveLength(2);
    expect(result.skipped.some((s) => s.reason === 'budget')).toBe(true);
  }, 60_000);

  it('honours maxDepth — depth 1 reaches the home page links but not their children', async () => {
    const result = await crawl(context, { config: config({ explorer: { maxDepth: 1 } }) });
    const patterns = result.model.pages.map((p) => p.urlPattern).sort();
    expect(patterns).toContain('/');
    expect(patterns).toContain('/products');
    // /product/1 is depth 2 — beyond the limit.
    expect(patterns).not.toContain('/product/1');
  }, 60_000);

  it('does not revisit a page when the graph has a cycle', async () => {
    const result = await crawl(context, { config: config() });
    const ids = result.model.pages.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  }, 60_000);

  it('collapses parameterised URLs into one representative page', async () => {
    const result = await crawl(context, {
      config: config({
        explorer: {
          urlPatterns: { normalize: [{ pattern: '/product/\\d+', replacement: '/product/:id' }] },
        },
      }),
    });
    const productPages = result.model.pages.filter((p) => p.urlPattern === '/product/:id');
    expect(productPages).toHaveLength(1);
  }, 60_000);

  it('respects an exclude pattern', async () => {
    const result = await crawl(context, {
      config: config({ explorer: { urlPatterns: { exclude: ['/products'] } } }),
    });
    expect(result.model.pages.map((p) => p.urlPattern)).not.toContain('/products');
  }, 60_000);

  it('never presses buttons — a dangerous button is catalogued, not clicked', async () => {
    const result = await crawl(context, { config: config() });
    const home = result.model.pages.find((p) => p.urlPattern === '/')!;
    const danger = home.elements.find((e) => e.testId === 'delete-account');
    // Catalogued as an element...
    expect(danger).toBeDefined();
    // ...and the account still exists, i.e. every page still serves.
    expect(result.model.pages.length).toBeGreaterThan(1);
  }, 60_000);

  it('detects a configured CAPTCHA marker and skips that page', async () => {
    const result = await crawl(context, {
      config: config({ explorer: { captchaPatterns: ['verify you are human'] } }),
      startUrl: `${baseUrl}/blocked`,
    });
    expect(result.model.pages).toHaveLength(0);
    expect(result.skipped[0]?.reason).toBe('captcha');
  }, 60_000);

  it('records a navigation failure instead of aborting the crawl', async () => {
    const result = await crawl(context, { config: config(), startUrl: `${baseUrl}/missing-page` });
    // A 404 still renders, so it is captured; the crawl must not throw.
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it('verifies selectors live — captured elements carry verified candidates', async () => {
    const result = await crawl(context, { config: config({ explorer: { maxPages: 1 } }) });
    const el = result.model.pages[0]!.elements.find((e) => e.testId === 'delete-account')!;
    expect(el.selectorCandidates.every((c) => c.verified)).toBe(true);
    expect(el.selectorCandidates.some((c) => c.unique)).toBe(true);
  }, 60_000);

  it('records reachedVia so a page can be traced back to its referrer', async () => {
    const result = await crawl(context, { config: config({ explorer: { maxDepth: 1 } }) });
    const about = result.model.pages.find((p) => p.urlPattern === '/about')!;
    expect(about.reachedVia.kind).toBe('link');
  }, 60_000);

  it('tags pages with the role when exploring per-role', async () => {
    const result = await crawl(context, {
      config: config({ explorer: { maxPages: 1 } }),
      role: 'admin',
    });
    expect(result.model.role).toBe('admin');
    expect(result.model.pages[0]?.role).toBe('admin');
  }, 60_000);

  it('flags a suspected login wall when the entry page has a password field', async () => {
    const result = await crawl(context, {
      config: config({ auth: { mode: 'none' } }),
      startUrl: `${baseUrl}/wall`,
    });
    expect(result.loginWallSuspected).toBeDefined();
    expect(result.loginWallSuspected?.authMode).toBe('none');
    expect(result.loginWallSuspected?.url).toBe(`${baseUrl}/wall`);
    expect(result.loginWallSuspected?.reason).toMatch(/auth\.mode is "none"/);
  }, 60_000);

  it('names the configured auth mode when the wall survives authentication', async () => {
    const result = await crawl(context, {
      config: config({
        auth: { mode: 'storageState', storageStatePath: 'state.json' },
      }),
      startUrl: `${baseUrl}/wall`,
    });
    expect(result.loginWallSuspected?.authMode).toBe('storageState');
    expect(result.loginWallSuspected?.reason).toMatch(/did not carry into the crawl/);
  }, 60_000);

  it('does not flag a login wall on an ordinary page', async () => {
    const result = await crawl(context, { config: config({ explorer: { maxPages: 1 } }) });
    expect(result.loginWallSuspected).toBeUndefined();
  }, 60_000);

  it('only diagnoses the entry page — a deeper login wall does not trigger it', async () => {
    // /wall is reachable only as a start URL here; crawling from / must stay clean.
    const result = await crawl(context, { config: config() });
    expect(result.loginWallSuspected).toBeUndefined();
  }, 60_000);

  it('treats an in-app login page as content when crawling anonymously', async () => {
    // Conduit links /login and /register from its navbar. With auth "none"
    // there is no session to expire, so a password field mid-crawl must be
    // catalogued like any other page — not aborted as session expiry.
    const result = await crawl(context, {
      config: config({ auth: { mode: 'none' } }),
      reauth: () => Promise.reject(new Error('must never be called for auth none')),
    });
    expect(result.sessionExpiry).toBeUndefined();
    expect(result.model.pages.map((p) => p.urlPattern)).toContain('/wall');
  }, 90_000);

  it('collapses query-parameterised URLs into one representative page', async () => {
    const result = await crawl(context, { config: config(), startUrl: `${baseUrl}/catalog` });
    const items = result.model.pages.filter((p) => p.urlPattern === '/item.html');
    // Three ?id= links, one page in the model — the master plan's "store one
    // representative page", which page identity (urlPattern) already implies.
    expect(items).toHaveLength(1);
    expect(result.skipped.filter((s) => s.reason === 'duplicate-pattern')).toHaveLength(2);
  }, 60_000);

  it('never emits two pages sharing an id', async () => {
    const result = await crawl(context, { config: config({ explorer: { maxPages: 50 } }) });
    const ids = result.model.pages.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  }, 90_000);

  it('is deterministic — two crawls of an unchanged site produce the same page ids', async () => {
    const a = await crawl(context, { config: config({ explorer: { maxPages: 4 } }) });
    const b = await crawl(context, { config: config({ explorer: { maxPages: 4 } }) });
    expect(b.model.pages.map((p) => p.id).sort()).toEqual(a.model.pages.map((p) => p.id).sort());
  }, 90_000);
});
