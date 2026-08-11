import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext } from '@playwright/test';
import { launchBrowser } from './browser.js';
import { createAuthenticatedContext, reauthenticate } from './auth.js';
import { crawl } from './crawler.js';
import { FlintConfigSchema, type FlintConfig } from '../schemas/config.js';

/**
 * Mid-crawl session expiry.
 *
 * The fixture logs the crawler in, serves a couple of pages, then throws the
 * session away — exactly what a short-lived token does in a real app. The
 * master plan allows one re-auth and then a resume; anything worse must end
 * with a saved partial model and a clear report, never a silent short crawl.
 */

let server: Server;
let baseUrl: string;
let browser: Browser;
let dir: string;

/** Session cookies the server currently accepts. */
let valid = new Set<string>();
/** Authenticated page loads served since the last reset. */
let authedLoads = 0;
/** Expire the session after this many authed loads; 0 disables. */
let expireAfter = 0;
/** Expiry fires once, so a re-auth can actually recover. */
let expiredOnce = false;
let sessionCounter = 0;

const PAGES: Record<string, string> = {
  '/home': `<html lang="en"><body><h1>Home</h1>
    <a href="/a">A</a><a href="/b">B</a><a href="/c">C</a></body></html>`,
  '/a': `<html lang="en"><body><h1>A</h1><button data-testid="a-btn">A</button></body></html>`,
  '/b': `<html lang="en"><body><h1>B</h1><button data-testid="b-btn">B</button></body></html>`,
  '/c': `<html lang="en"><body><h1>C</h1><button data-testid="c-btn">C</button></body></html>`,
};

const LOGIN_PAGE = `<html lang="en"><body><h1>Sign in</h1>
  <form method="POST" action="/login">
    <input name="username" placeholder="Username">
    <input name="password" type="password" placeholder="Password">
    <button type="submit" id="login-button">Login</button>
  </form></body></html>`;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    const cookie = /flint-session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    const authed = cookie !== undefined && valid.has(cookie);

    if (path === '/login' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const params = new URLSearchParams(body);
        if (params.get('username') === 'good' && params.get('password') === 'pw') {
          sessionCounter += 1;
          const token = `s${sessionCounter}`;
          valid.add(token);
          res.writeHead(302, { location: '/home', 'set-cookie': `flint-session=${token}` });
          res.end();
          return;
        }
        html(res, LOGIN_PAGE);
      });
      return;
    }
    if (path === '/login' || !authed) {
      html(res, LOGIN_PAGE);
      return;
    }

    // Count only real page loads. The browser also asks for /favicon.ico after
    // every navigation, and letting that drive expiry makes the test lie about
    // which page the wall appears on.
    if (!(path in PAGES)) {
      html(res, '<html lang="en"><body><h1>404</h1></body></html>');
      return;
    }

    authedLoads += 1;
    if (expireAfter > 0 && !expiredOnce && authedLoads > expireAfter) {
      // The session dies *before* this page is served, so the crawler sees a
      // login wall on a URL it had every reason to expect content on.
      valid = new Set();
      expiredOnce = true;
      html(res, LOGIN_PAGE);
      return;
    }
    html(res, PAGES[path]!);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await launchBrowser({ proxyServer: '' });
  dir = mkdtempSync(join(tmpdir(), 'flint-expiry-'));
}, 120_000);

afterAll(async () => {
  await browser?.close().catch(() => undefined);
  await new Promise<void>((r) => server?.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  valid = new Set();
  authedLoads = 0;
  expireAfter = 0;
  expiredOnce = false;
});

function html(res: ServerResponse, body: string): void {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(body);
}

function config(): FlintConfig {
  return FlintConfigSchema.parse({
    baseUrl: `${baseUrl}/home`,
    envClass: 'test',
    models: { planner: 'a', coder: 'b', repair: 'c' },
    auth: {
      mode: 'credentials',
      username: 'good',
      password: 'pw',
      loginUrl: `${baseUrl}/login`,
    },
  });
}

async function authedContext(): Promise<BrowserContext> {
  const session = await createAuthenticatedContext(browser, {
    config: config(),
    projectRoot: dir,
  });
  return session.context;
}

describe('mid-crawl session expiry', () => {
  it('crawls the whole app when the session holds', async () => {
    const context = await authedContext();
    try {
      const result = await crawl(context, { config: config(), interactionPass: false });
      expect(result.model.pages.map((p) => p.urlPattern).sort()).toEqual([
        '/a',
        '/b',
        '/c',
        '/home',
      ]);
      expect(result.sessionExpiry).toBeUndefined();
    } finally {
      await context.close();
    }
  }, 90_000);

  it('re-authenticates once and finishes the crawl', async () => {
    const context = await authedContext();
    expireAfter = 2;
    try {
      const result = await crawl(context, {
        config: config(),
        interactionPass: false,
        reauth: () => reauthenticate(context, { config: config(), projectRoot: dir }),
      });
      expect(result.sessionExpiry?.recovered).toBe(true);
      // Recovery means the page that hit the wall is captured for real, and
      // the rest of the frontier is still crawled.
      expect(result.model.pages.map((p) => p.urlPattern).sort()).toEqual([
        '/a',
        '/b',
        '/c',
        '/home',
      ]);
    } finally {
      await context.close();
    }
  }, 120_000);

  it('stops with a partial model when it cannot re-authenticate', async () => {
    const context = await authedContext();
    expireAfter = 2;
    try {
      const result = await crawl(context, { config: config(), interactionPass: false });
      expect(result.sessionExpiry?.recovered).toBe(false);
      expect(result.sessionExpiry?.detail).toMatch(/no re-authentication callback/);
      // Partial, and saying so: fewer pages than the app has, and the
      // un-crawled remainder reported as aborted rather than budgeted.
      expect(result.model.pages.length).toBeLessThan(4);
      expect(result.model.pages.length).toBeGreaterThan(0);
      expect(result.skipped.some((s) => s.reason === 'aborted')).toBe(true);
    } finally {
      await context.close();
    }
  }, 90_000);

  it('surfaces a failing re-auth rather than crawling on anonymously', async () => {
    const context = await authedContext();
    expireAfter = 2;
    try {
      const result = await crawl(context, {
        config: config(),
        interactionPass: false,
        reauth: () => Promise.reject(new Error('identity provider unreachable')),
      });
      expect(result.sessionExpiry?.recovered).toBe(false);
      expect(result.sessionExpiry?.detail).toBe('identity provider unreachable');
    } finally {
      await context.close();
    }
  }, 90_000);
});

describe('reauthenticate', () => {
  it('refuses when auth.mode is "none", naming the modes that work', async () => {
    const context = await browser.newContext();
    try {
      await expect(
        reauthenticate(context, {
          config: FlintConfigSchema.parse({
            baseUrl,
            envClass: 'test',
            models: { planner: 'a', coder: 'b', repair: 'c' },
          }),
          projectRoot: dir,
        }),
      ).rejects.toThrow(/Cannot re-authenticate: auth\.mode is "none"/);
    } finally {
      await context.close();
    }
  });

  it('refuses for storageState, since the stored session is the expired one', async () => {
    const context = await browser.newContext();
    try {
      await expect(
        reauthenticate(context, {
          config: FlintConfigSchema.parse({
            baseUrl,
            envClass: 'test',
            models: { planner: 'a', coder: 'b', repair: 'c' },
            auth: { mode: 'storageState', storageStatePath: 'state.json' },
          }),
          projectRoot: dir,
        }),
      ).rejects.toThrow(/Cannot re-authenticate from a storageState file/);
    } finally {
      await context.close();
    }
  });
});
