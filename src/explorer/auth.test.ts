import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from '@playwright/test';
import { launchBrowser } from './browser.js';
import { createAuthenticatedContext, loadLoginScript, looksLikeLoginWall } from './auth.js';
import { FlintConfigSchema, type FlintConfig } from '../schemas/config.js';
import { FlintError } from '../shared/errors.js';

/**
 * Auth tests run a fixture app with a real login form over real HTTP, so the
 * credential flow is exercised end to end rather than mocked.
 */

const SESSION = 'flint-session=1';

let server: Server;
let baseUrl: string;
let browser: Browser;
let dir: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    const authed = (req.headers.cookie ?? '').includes(SESSION);

    if (path === '/login' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const params = new URLSearchParams(body);
        if (params.get('username') === 'good' && params.get('password') === 'pw') {
          res.writeHead(302, { location: '/dashboard', 'set-cookie': SESSION });
          res.end();
        } else {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end(loginPage('Invalid credentials'));
        }
      });
      return;
    }
    if (path === '/login') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(loginPage());
      return;
    }
    // An SPA-style login: submit is intercepted, no navigation ever happens,
    // and the form is swapped out client-side after a short "API call".
    if (path === '/spa-login') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<html lang="en"><body>
        <h1>Sign in</h1>
        <form id="f">
          <input name="username" placeholder="Username">
          <input name="password" type="password" placeholder="Password">
          <button type="submit" id="login-button">Login</button>
        </form>
        <script>
          document.getElementById('f').addEventListener('submit', function (e) {
            e.preventDefault();
            setTimeout(function () {
              document.body.innerHTML = '<h1>Dashboard</h1>';
            }, 400);
          });
        </script>
      </body></html>`);
      return;
    }
    // A public page with no login form at all — used to prove that credential
    // login fails loudly rather than silently proceeding unauthenticated.
    if (path === '/public') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html lang="en"><body><h1>Public</h1><p>No form here.</p></body></html>');
      return;
    }
    if (!authed) {
      // Everything else is behind the login wall.
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(loginPage());
      return;
    }
    if (path === '/dashboard') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        `<html lang="en"><body><h1>Dashboard</h1><a href="/reports">Reports</a>
         <button data-testid="new">New</button></body></html>`,
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html lang="en"><body><h1>Reports</h1><a href="/dashboard">Back</a></body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await launchBrowser({ proxyServer: '' });
  dir = mkdtempSync(join(tmpdir(), 'flint-auth-'));
}, 120_000);

afterAll(async () => {
  await browser?.close().catch(() => undefined);
  await new Promise<void>((r) => server?.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

function loginPage(error = ''): string {
  return `<html lang="en"><body>
    <h1>Sign in</h1>
    ${error !== '' ? `<p>${error}</p>` : ''}
    <form method="POST" action="/login">
      <input name="username" placeholder="Username">
      <input name="password" type="password" placeholder="Password">
      <button type="submit" id="login-button">Login</button>
    </form>
  </body></html>`;
}

function config(auth: Record<string, unknown>): FlintConfig {
  return FlintConfigSchema.parse({
    baseUrl,
    envClass: 'test',
    models: { planner: 'a', coder: 'b', repair: 'c' },
    auth,
  });
}

describe('auth mode: none', () => {
  it('returns a plain context', async () => {
    const { context: ctx } = await createAuthenticatedContext(browser, {
      config: config({ mode: 'none' }),
      projectRoot: dir,
    });
    const page = await ctx.newPage();
    await page.goto(`${baseUrl}/dashboard`);
    // Unauthenticated: the login wall is served instead of the dashboard.
    expect(await looksLikeLoginWall(page)).toBe(true);
    await ctx.close();
  }, 60_000);
});

describe('auth mode: credentials', () => {
  it('logs in and yields an authenticated context', async () => {
    const { context: ctx } = await createAuthenticatedContext(browser, {
      config: config({
        mode: 'credentials',
        username: 'good',
        password: 'pw',
        loginUrl: `${baseUrl}/login`,
      }),
      projectRoot: dir,
    });
    const page = await ctx.newPage();
    await page.goto(`${baseUrl}/dashboard`);
    expect(await page.locator('h1').innerText()).toBe('Dashboard');
    expect(await looksLikeLoginWall(page)).toBe(false);
    await ctx.close();
  }, 60_000);

  it('reports where the login landed, so the crawl can start inside the app', async () => {
    const session = await createAuthenticatedContext(browser, {
      config: config({
        mode: 'credentials',
        username: 'good',
        password: 'pw',
        loginUrl: `${baseUrl}/login`,
      }),
      projectRoot: dir,
    });
    // The login redirected to /dashboard. Without this the caller would have
    // to restart at baseUrl — which on apps like saucedemo *is* the login
    // page, so the crawl would never get inside the app at all.
    expect(session.landingUrl).toBe(`${baseUrl}/dashboard`);
    await session.context.close();
  }, 60_000);

  it('waits out an SPA login that swaps the form without navigating', async () => {
    // The password field is still visible at domcontentloaded; an instant
    // check would declare failure. The bounded settle wait must not.
    const { context: ctx } = await createAuthenticatedContext(browser, {
      config: config({
        mode: 'credentials',
        username: 'good',
        password: 'pw',
        loginUrl: `${baseUrl}/spa-login`,
      }),
      projectRoot: dir,
    });
    await ctx.close();
  }, 60_000);

  it('fails loudly on bad credentials rather than crawling anonymously', async () => {
    await expect(
      createAuthenticatedContext(browser, {
        config: config({
          mode: 'credentials',
          username: 'bad',
          password: 'wrong',
          loginUrl: `${baseUrl}/login`,
        }),
        projectRoot: dir,
      }),
    ).rejects.toThrow(/Login appears to have failed/);
  }, 60_000);

  it('names the missing field when the login page has no form', async () => {
    await expect(
      createAuthenticatedContext(browser, {
        config: config({
          mode: 'credentials',
          username: 'good',
          password: 'pw',
          loginUrl: `${baseUrl}/public`,
        }),
        projectRoot: dir,
      }),
    ).rejects.toThrow(/Could not find a username field/);
  }, 60_000);
});

describe('auth mode: storageState', () => {
  it('errors actionably when the file is missing', async () => {
    await expect(
      createAuthenticatedContext(browser, {
        config: config({ mode: 'storageState', storageStatePath: 'nope.json' }),
        projectRoot: dir,
      }),
    ).rejects.toThrow(/storageState file not found/);
  });

  it('reuses a saved session', async () => {
    // Log in once and persist the session.
    const { context: seed } = await createAuthenticatedContext(browser, {
      config: config({
        mode: 'credentials',
        username: 'good',
        password: 'pw',
        loginUrl: `${baseUrl}/login`,
      }),
      projectRoot: dir,
    });
    const statePath = join(dir, 'state.json');
    await seed.storageState({ path: statePath });
    await seed.close();

    const { context: ctx } = await createAuthenticatedContext(browser, {
      config: config({ mode: 'storageState', storageStatePath: statePath }),
      projectRoot: dir,
    });
    const page = await ctx.newPage();
    await page.goto(`${baseUrl}/dashboard`);
    expect(await page.locator('h1').innerText()).toBe('Dashboard');
    await ctx.close();
  }, 90_000);
});

describe('auth mode: loginScript', () => {
  it('runs a user-supplied script', async () => {
    const scriptPath = join(dir, 'login.mjs');
    writeFileSync(
      scriptPath,
      `export default async (page) => {
         await page.goto('${baseUrl}/login');
         await page.fill('input[name="username"]', 'good');
         await page.fill('input[name="password"]', 'pw');
         await page.click('#login-button');
         await page.waitForLoadState('domcontentloaded');
       };`,
      'utf8',
    );
    const { context: ctx } = await createAuthenticatedContext(browser, {
      config: config({ mode: 'loginScript', loginScriptPath: scriptPath }),
      projectRoot: dir,
    });
    const page = await ctx.newPage();
    await page.goto(`${baseUrl}/dashboard`);
    expect(await page.locator('h1').innerText()).toBe('Dashboard');
    await ctx.close();
  }, 90_000);

  it('errors actionably when the script is missing', async () => {
    await expect(loadLoginScript(join(dir, 'missing.mjs'))).rejects.toThrow(
      /Login script not found/,
    );
  });

  it('errors actionably when the script exports no default function', async () => {
    const bad = join(dir, 'bad.mjs');
    writeFileSync(bad, 'export const notDefault = 1;', 'utf8');
    await expect(loadLoginScript(bad)).rejects.toThrow(/must export a default function/);
  });

  it('surfaces a throwing script as a FlintError with the path', async () => {
    const boom = join(dir, 'boom.mjs');
    writeFileSync(boom, 'export default async () => { throw new Error("nope"); };', 'utf8');
    const promise = createAuthenticatedContext(browser, {
      config: config({ mode: 'loginScript', loginScriptPath: boom }),
      projectRoot: dir,
    });
    await expect(promise).rejects.toThrowError(FlintError);
    await expect(promise).rejects.toThrow(/login script threw/i);
  }, 60_000);
});
