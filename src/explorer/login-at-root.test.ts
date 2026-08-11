import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from '@playwright/test';
import { launchBrowser } from './browser.js';
import { createAuthenticatedContext, knownLoginUrl } from './auth.js';
import { crawl } from './crawler.js';
import { FlintConfigSchema, type FlintConfig } from '../schemas/config.js';

/**
 * The saucedemo shape: `baseUrl` **is** the login page, and it keeps serving
 * the sign-in form after you authenticate — there is no redirect for a
 * logged-in visitor.
 *
 * This broke the first real demo-app run. Login succeeded, then the crawl
 * restarted at `baseUrl`, landed back on the form, and reported one page with
 * a "session did not carry into the crawl" warning. Everything was working
 * except the choice of entry point.
 */

const SESSION = 'sd-session=1';

let server: Server;
let baseUrl: string;
let browser: Browser;
let dir: string;

const INVENTORY = `<html lang="en"><body><h1>Products</h1>
  <a href="/cart.html">Cart</a><a href="/inventory-item.html?id=1">Item</a>
  <button data-testid="add-backpack">Add to cart</button></body></html>`;

beforeAll(async () => {
  server = createServer((req, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0]!;
    const authed = (req.headers.cookie ?? '').includes(SESSION);

    // The root always serves the login form, authenticated or not — exactly
    // what saucedemo does.
    if (path === '/' || path === '') {
      if (req.method === 'POST') {
        res.writeHead(302, { location: '/inventory.html', 'set-cookie': SESSION });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<html lang="en"><body><h1>Swag Labs</h1>
        <form method="POST" action="/">
          <input id="user-name" name="username" placeholder="Username">
          <input id="password" name="password" type="password" placeholder="Password">
          <input type="submit" id="login-button" value="Login">
        </form></body></html>`);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    if (!authed) {
      res.end('<html lang="en"><body><h1>Epic sadface</h1></body></html>');
      return;
    }
    if (path === '/inventory.html') return void res.end(INVENTORY);
    if (path === '/cart.html') {
      res.end(
        `<html lang="en"><body><h1>Cart</h1><a href="/inventory.html">Continue</a>
         <button data-testid="checkout">Checkout</button></body></html>`,
      );
      return;
    }
    res.end(
      `<html lang="en"><body><h1>Item</h1><a href="/inventory.html">Back</a>
       <button data-testid="add">Add</button></body></html>`,
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await launchBrowser({ proxyServer: '' });
  dir = mkdtempSync(join(tmpdir(), 'flint-root-login-'));
}, 120_000);

afterAll(async () => {
  await browser?.close().catch(() => undefined);
  await new Promise<void>((r) => server?.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

function config(): FlintConfig {
  return FlintConfigSchema.parse({
    baseUrl,
    envClass: 'test',
    models: { planner: 'a', coder: 'b', repair: 'c' },
    auth: { mode: 'credentials', username: 'standard_user', password: 'secret_sauce' },
  });
}

describe('an app whose baseUrl is its login page', () => {
  it('starts the crawl where the login landed, not back at the form', async () => {
    const session = await createAuthenticatedContext(browser, {
      config: config(),
      projectRoot: dir,
    });
    expect(session.landingUrl).toBe(`${baseUrl}/inventory.html`);

    try {
      const result = await crawl(session.context, {
        config: config(),
        startUrl: session.landingUrl!,
        alsoCrawl: [baseUrl],
        interactionPass: false,
      });

      const patterns = result.model.pages.map((p) => p.urlPattern).sort();
      // The authenticated app, not one login screen.
      expect(patterns).toContain('/inventory.html');
      expect(patterns).toContain('/cart.html');
      expect(result.model.pages.length).toBeGreaterThan(2);

      // The sign-in page is still modelled — Phase 4 needs it to generate a
      // login test — but it is not what the crawl started from.
      expect(patterns).toContain('/');

      // And none of that counts as session expiry.
      expect(result.sessionExpiry).toBeUndefined();
      expect(result.loginWallSuspected).toBeUndefined();
    } finally {
      await session.context.close();
    }
  }, 120_000);

  it('does not mistake the app’s own sign-in page for an expired session', async () => {
    const session = await createAuthenticatedContext(browser, {
      config: config(),
      projectRoot: dir,
    });
    try {
      // Crawl from the inventory page; `/` is linked nowhere, so seed it as an
      // extra entry the way the CLI does. It shows a password field at depth 0
      // and must still be treated as content.
      const result = await crawl(session.context, {
        config: config(),
        startUrl: `${baseUrl}/inventory.html`,
        alsoCrawl: [baseUrl],
        interactionPass: false,
        reauth: () => Promise.reject(new Error('re-auth must not be attempted')),
      });
      expect(result.sessionExpiry).toBeUndefined();
    } finally {
      await session.context.close();
    }
  }, 120_000);

  it('knows where the login form lives so the crawler can exempt it', () => {
    // No explicit loginUrl configured => baseUrl is the login page.
    expect(knownLoginUrl(config())).toBe(baseUrl);
    expect(
      knownLoginUrl(
        FlintConfigSchema.parse({
          baseUrl,
          envClass: 'test',
          models: { planner: 'a', coder: 'b', repair: 'c' },
        }),
      ),
    ).toBeUndefined();
  });
});
