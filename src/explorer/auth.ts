import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { createJiti } from 'jiti';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import type { AuthConfig, FlintConfig } from '../schemas/config.js';
import { FlintError } from '../shared/errors.js';
import { silentLogger, type Logger } from '../shared/logger.js';
import { createContext } from './browser.js';

/**
 * Auth bootstrap — produces an authenticated {@link BrowserContext}.
 *
 * Three modes (master plan Phase 1):
 *   - `storageState`: reuse a Playwright storageState file the user already has
 *   - `loginScript` : run a user-supplied TS function that drives the login
 *   - `credentials` : replay a generic login form with username/password
 *
 * Credentials never appear in the Screen Model or any log line. The whole point
 * of this module is that everything downstream just receives a context that is
 * already logged in.
 */

export interface AuthOptions {
  config: FlintConfig;
  projectRoot: string;
  logger?: Logger;
}

/** The shape a `loginScript` module must export. */
export type LoginScript = (page: Page) => Promise<void>;

/** Build a context, authenticating first when the config asks for it. */
export async function createAuthenticatedContext(
  browser: Browser,
  options: AuthOptions,
): Promise<BrowserContext> {
  const { config, projectRoot } = options;
  const logger = options.logger ?? silentLogger();
  const auth = config.auth;

  switch (auth.mode) {
    case 'none':
      return createContext(browser);

    case 'storageState': {
      const path = absolute(projectRoot, auth.storageStatePath);
      if (!existsSync(path)) {
        throw new FlintError(`storageState file not found: ${path}.`, {
          code: 'AUTH',
          hint: 'Generate it with `npx playwright codegen --save-storage=<path>`, or switch auth.mode to "credentials".',
        });
      }
      logger.info({ mode: 'storageState' }, 'auth: reusing stored session');
      return createContext(browser, { storageStatePath: path });
    }

    case 'loginScript': {
      const script = await loadLoginScript(absolute(projectRoot, auth.loginScriptPath));
      const context = await createContext(browser);
      const page = await context.newPage();
      try {
        await script(page);
        logger.info({ mode: 'loginScript' }, 'auth: login script completed');
      } catch (err) {
        await context.close().catch(() => undefined);
        throw new FlintError('The login script threw while authenticating.', {
          code: 'AUTH',
          cause: err,
          hint: `Check ${auth.loginScriptPath}. It receives a Playwright Page and must leave it logged in.`,
        });
      } finally {
        await page.close().catch(() => undefined);
      }
      return context;
    }

    case 'credentials': {
      const context = await createContext(browser);
      const page = await context.newPage();
      try {
        await performCredentialLogin(page, auth, config.baseUrl);
        logger.info({ mode: 'credentials', user: auth.username }, 'auth: credential login OK');
      } catch (err) {
        await context.close().catch(() => undefined);
        throw err;
      } finally {
        await page.close().catch(() => undefined);
      }
      return context;
    }
  }
}

/**
 * Re-authenticate an existing context in place.
 *
 * Used when a session expires mid-crawl: the crawler has a half-built model it
 * does not want to throw away, so rather than restarting it logs back in on the
 * same context and resumes. Only the two modes that actually hold credentials
 * can do this — the others say so instead of silently continuing anonymously.
 */
export async function reauthenticate(context: BrowserContext, options: AuthOptions): Promise<void> {
  const { config, projectRoot } = options;
  const logger = options.logger ?? silentLogger();
  const auth = config.auth;

  if (auth.mode === 'none') {
    throw new FlintError('Cannot re-authenticate: auth.mode is "none".', {
      code: 'AUTH',
      hint: 'The app returned a login screen mid-crawl. Configure auth.mode "credentials" or "loginScript" so Flint can log back in.',
    });
  }
  if (auth.mode === 'storageState') {
    throw new FlintError('Cannot re-authenticate from a storageState file.', {
      code: 'AUTH',
      hint: 'The stored session expired. Regenerate the storageState file, or switch to auth.mode "credentials"/"loginScript" so Flint can log in again on its own.',
    });
  }

  const page = await context.newPage();
  try {
    if (auth.mode === 'loginScript') {
      const script = await loadLoginScript(absolute(projectRoot, auth.loginScriptPath));
      await script(page);
    } else {
      await performCredentialLogin(page, auth, config.baseUrl);
    }
    logger.info({ mode: auth.mode }, 'auth: re-authenticated mid-crawl');
  } finally {
    await page.close().catch(() => undefined);
  }
}

function absolute(projectRoot: string, path: string): string {
  return isAbsolute(path) ? path : resolve(projectRoot, path);
}

/** Load and validate a user-supplied login script (TS or JS, via jiti). */
export async function loadLoginScript(path: string): Promise<LoginScript> {
  if (!existsSync(path)) {
    throw new FlintError(`Login script not found: ${path}.`, {
      code: 'AUTH',
      hint: 'Point auth.loginScriptPath at a .ts/.js file exporting a default async (page) => {...}.',
    });
  }
  let mod: unknown;
  try {
    const jiti = createJiti(import.meta.url);
    mod = await jiti.import(path);
  } catch (err) {
    throw new FlintError(`Failed to load the login script: ${path}.`, {
      code: 'AUTH',
      cause: err,
      hint: err instanceof Error ? err.message : undefined,
    });
  }
  const fn = extractDefault(mod);
  if (typeof fn !== 'function') {
    throw new FlintError(`Login script must export a default function: ${path}.`, {
      code: 'AUTH',
      hint: 'Example: export default async (page) => { await page.goto("/login"); ... }',
    });
  }
  return fn as LoginScript;
}

function extractDefault(mod: unknown): unknown {
  if (mod !== null && typeof mod === 'object' && 'default' in mod) {
    return (mod as { default: unknown }).default;
  }
  return mod;
}

/**
 * Fill and submit a conventional login form.
 *
 * Field discovery is best-effort across the shapes real apps use. When it
 * cannot find a field it fails loudly naming what was missing — guessing here
 * would mean typing a password into an unknown input.
 */
export async function performCredentialLogin(
  page: Page,
  auth: Extract<AuthConfig, { mode: 'credentials' }>,
  baseUrl: string,
): Promise<void> {
  const loginUrl = auth.loginUrl ?? baseUrl;
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });

  const username = await firstVisible(page, USERNAME_SELECTORS);
  if (username === undefined) {
    throw new FlintError(`Could not find a username field on ${loginUrl}.`, {
      code: 'AUTH',
      hint: 'Set auth.loginUrl to the actual login page, or switch to auth.mode "loginScript" for a custom flow.',
    });
  }
  const password = await firstVisible(page, PASSWORD_SELECTORS);
  if (password === undefined) {
    throw new FlintError(`Could not find a password field on ${loginUrl}.`, {
      code: 'AUTH',
      hint: 'Set auth.loginUrl to the actual login page, or switch to auth.mode "loginScript" for a custom flow.',
    });
  }

  await page.fill(username, auth.username);
  await page.fill(password, auth.password);

  const submit = await firstVisible(page, SUBMIT_SELECTORS);
  if (submit === undefined) {
    // Enter submits most forms; try that before giving up.
    await page.press(password, 'Enter');
  } else {
    await page.click(submit);
  }

  await page.waitForLoadState('domcontentloaded').catch(() => undefined);

  // Still on a password field ⇒ the login did not take. Fail loudly rather
  // than crawling an anonymous session and reporting an empty app.
  const stillOnLogin = await firstVisible(page, PASSWORD_SELECTORS);
  if (stillOnLogin !== undefined) {
    throw new FlintError('Login appears to have failed — a password field is still visible.', {
      code: 'AUTH',
      hint: 'Check auth.username / auth.password, or whether the app shows an error (locked-out user, CAPTCHA).',
    });
  }
}

const USERNAME_SELECTORS = [
  '#user-name',
  'input[name="username"]',
  'input[name="user"]',
  'input[name="email"]',
  'input[type="email"]',
  'input[id*="user" i]',
  'input[id*="email" i]',
  'input[placeholder*="user" i]',
  'input[placeholder*="email" i]',
];

const PASSWORD_SELECTORS = ['input[type="password"]', 'input[name="password"]', '#password'];

const SUBMIT_SELECTORS = [
  'input[type="submit"]',
  'button[type="submit"]',
  '#login-button',
  'button[id*="login" i]',
  'button[name*="login" i]',
];

/** First selector in the list that resolves to exactly one visible element. */
async function firstVisible(page: Page, selectors: string[]): Promise<string | undefined> {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    if (count !== 1) continue;
    if (await locator.isVisible().catch(() => false)) return selector;
  }
  return undefined;
}

/**
 * Is this page a login wall? Used mid-crawl to detect session expiry, which
 * the master plan says should trigger exactly one re-auth before aborting.
 */
export async function looksLikeLoginWall(page: Page): Promise<boolean> {
  const password = await firstVisible(page, PASSWORD_SELECTORS);
  return password !== undefined;
}
