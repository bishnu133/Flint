import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { launchBrowser, createContext } from './browser.js';
import { crawl } from './crawler.js';
import { discoverClientRoutes } from './route-discovery.js';
import { waitForDomStable } from './wait.js';
import { FlintConfigSchema, type FlintConfig } from '../schemas/config.js';

/**
 * The saucedemo shape, again: a client-rendered app whose links carry no
 * navigable href. `<a href="#">` with a click handler that calls the router is
 * invisible to a crawler that follows hrefs, so the whole app looks like one
 * page. The routes themselves are perfectly ordinary URLs.
 */

const SHELL = (body: string): string => `<html lang="en"><body>${body}
  <script>
    document.addEventListener('click', function (e) {
      var t = e.target.closest('[data-route]');
      if (t === null) return;
      e.preventDefault();
      history.pushState({}, '', t.getAttribute('data-route'));
      document.getElementById('view').textContent = 'Routed to ' + t.getAttribute('data-route');
    });
  </script></body></html>`;

const HOME = SHELL(`
  <h1>Home</h1>
  <div id="view"></div>
  <a href="#" data-route="/products">Products</a>
  <a href="#" data-route="/cart">Cart</a>
  <a href="javascript:void(0)" data-route="/account">Account</a>
  <div role="link" data-route="/help">Help</div>
  <a href="#" data-route="/danger">Delete everything</a>
  <button data-testid="not-a-link" data-route="/never">Button</button>
`);

/** A conventional server-rendered page — route discovery must not run here. */
const SERVER_RENDERED = `<html lang="en"><body><h1>Server</h1>
  <a href="/products">Products</a><a href="/cart">Cart</a></body></html>`;

let server: Server;
let baseUrl: string;
let browser: Browser;
let context: BrowserContext;
let page: Page;

beforeAll(async () => {
  server = createServer((req, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0]!;
    res.writeHead(200, { 'content-type': 'text/html' });
    if (path === '/server') return void res.end(SERVER_RENDERED);
    if (path === '/') return void res.end(HOME);
    // Every route resolves to a real page when navigated to directly.
    res.end(
      `<html lang="en"><body><h1>${path}</h1>
       <button data-testid="cta-${path.slice(1)}">Act</button></body></html>`,
    );
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

function config(overrides: Record<string, unknown> = {}): FlintConfig {
  return FlintConfigSchema.parse({
    baseUrl,
    envClass: 'test',
    models: { planner: 'a', coder: 'b', repair: 'c' },
    ...overrides,
  });
}

describe('discoverClientRoutes', () => {
  it('finds routes behind href="#" links', async () => {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await waitForDomStable(page);
    const routes = await discoverClientRoutes(page, { dangerousActionPatterns: [] });
    const paths = routes.map((r) => new URL(r.url).pathname).sort();
    expect(paths).toContain('/products');
    expect(paths).toContain('/cart');
  }, 90_000);

  it('follows javascript: hrefs and role="link" elements too', async () => {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await waitForDomStable(page);
    const routes = await discoverClientRoutes(page, { dangerousActionPatterns: [] });
    const paths = routes.map((r) => new URL(r.url).pathname);
    expect(paths).toContain('/account');
    expect(paths).toContain('/help');
  }, 90_000);

  it('never clicks a link on the dangerous-action denylist', async () => {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await waitForDomStable(page);
    const routes = await discoverClientRoutes(page, { dangerousActionPatterns: ['delete'] });
    expect(routes.map((r) => new URL(r.url).pathname)).not.toContain('/danger');
  }, 90_000);

  it('leaves the page where it found it', async () => {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await waitForDomStable(page);
    await discoverClientRoutes(page, { dangerousActionPatterns: [] });
    expect(page.url().replace(/\/$/, '')).toBe(baseUrl);
  }, 90_000);

  it('respects maxLinks', async () => {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await waitForDomStable(page);
    const routes = await discoverClientRoutes(page, {
      dangerousActionPatterns: [],
      maxLinks: 1,
    });
    expect(routes.length).toBeLessThanOrEqual(1);
  }, 90_000);

  it('records which link led to each route', async () => {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await waitForDomStable(page);
    const routes = await discoverClientRoutes(page, { dangerousActionPatterns: [] });
    const cart = routes.find((r) => new URL(r.url).pathname === '/cart');
    expect(cart?.via).toBe('Cart');
  }, 90_000);
});

describe('crawl with client-side routing', () => {
  it('crawls an app whose links have no href', async () => {
    const result = await crawl(context, { config: config(), interactionPass: false });
    const patterns = result.model.pages.map((p) => p.urlPattern).sort();
    // Without route discovery this crawl finds exactly one page.
    expect(patterns).toContain('/products');
    expect(patterns).toContain('/cart');
    expect(result.model.pages.length).toBeGreaterThan(3);
  }, 180_000);

  it('captures real elements on the discovered pages', async () => {
    const result = await crawl(context, { config: config(), interactionPass: false });
    const products = result.model.pages.find((p) => p.urlPattern === '/products')!;
    expect(products.elements.map((e) => e.testId)).toContain('cta-products');
  }, 180_000);

  it('honours the denylist during a full crawl', async () => {
    const result = await crawl(context, {
      config: config({ explorer: { dangerousActionPatterns: ['delete'] } }),
      interactionPass: false,
    });
    expect(result.model.pages.map((p) => p.urlPattern)).not.toContain('/danger');
  }, 180_000);

  it('does not click anything on a server-rendered page', async () => {
    // /server has real hrefs, so discovery must be skipped entirely — the
    // crawl still works and costs no extra navigations.
    const result = await crawl(context, {
      config: config(),
      startUrl: `${baseUrl}/server`,
      interactionPass: false,
    });
    const patterns = result.model.pages.map((p) => p.urlPattern).sort();
    expect(patterns).toContain('/server');
    expect(patterns).toContain('/products');
  }, 180_000);

  it('can be turned off', async () => {
    const result = await crawl(context, {
      config: config(),
      interactionPass: false,
      routeDiscovery: false,
    });
    // Back to the old behaviour: one page, nothing discoverable.
    expect(result.model.pages).toHaveLength(1);
  }, 90_000);
});
