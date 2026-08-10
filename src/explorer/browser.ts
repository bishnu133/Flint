import { chromium, type Browser, type BrowserContext } from '@playwright/test';
import { ProviderError } from '../shared/errors.js';

/**
 * Browser lifecycle for the Explorer.
 *
 * Playwright normally manages its own browser download. Some environments
 * cannot rely on that — CI images that pre-provision browsers, machines where
 * the download is blocked by a proxy, or a pinned system Chrome. Setting
 * `FLINT_BROWSER_EXECUTABLE` points Playwright at an existing binary instead.
 */
export const BROWSER_EXECUTABLE_ENV = 'FLINT_BROWSER_EXECUTABLE';

export interface LaunchOptions {
  /** Run with a visible window. Default false (headless). */
  headed?: boolean;
  /** Override the browser binary; defaults to `FLINT_BROWSER_EXECUTABLE`. */
  executablePath?: string;
  /** Per-action timeout in ms. */
  timeoutMs?: number;
}

export async function launchBrowser(options: LaunchOptions = {}): Promise<Browser> {
  const executablePath = options.executablePath ?? process.env[BROWSER_EXECUTABLE_ENV];
  try {
    return await chromium.launch({
      headless: options.headed !== true,
      ...(executablePath !== undefined && executablePath !== '' ? { executablePath } : {}),
    });
  } catch (err) {
    throw new ProviderError('Could not launch Chromium.', {
      cause: err,
      hint:
        `Run \`npx playwright install chromium\` to download it, or set ${BROWSER_EXECUTABLE_ENV} ` +
        `to an existing Chrome/Chromium binary. Behind a TLS-inspecting proxy the download often ` +
        `fails — see PHASE_NOTES.md for the CA setup.`,
    });
  }
}

export interface ContextOptions {
  /** Playwright storageState path produced by auth bootstrap. */
  storageStatePath?: string;
  viewport?: { width: number; height: number };
  timeoutMs?: number;
}

/** Create a browsing context, optionally pre-authenticated via storageState. */
export async function createContext(
  browser: Browser,
  options: ContextOptions = {},
): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1280, height: 800 },
    ...(options.storageStatePath !== undefined ? { storageState: options.storageStatePath } : {}),
  });
  if (options.timeoutMs !== undefined) {
    context.setDefaultTimeout(options.timeoutMs);
  }
  return context;
}
