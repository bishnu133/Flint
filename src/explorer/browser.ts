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
  /** Proxy server URL; defaults to HTTPS_PROXY / HTTP_PROXY from the env. */
  proxyServer?: string;
  /** Comma-separated no-proxy list; defaults to NO_PROXY from the env. */
  noProxy?: string;
}

/**
 * Resolve proxy settings from options or the standard env vars.
 *
 * Playwright does NOT inherit `HTTPS_PROXY` the way curl and Node do — it must
 * be passed explicitly at launch. Without this, a browser on a corporate
 * network fails every navigation with `ERR_TUNNEL_CONNECTION_FAILED` while
 * every other tool on the same machine works fine.
 */
export function resolveProxy(
  options: LaunchOptions = {},
): { server: string; bypass?: string } | undefined {
  const server =
    options.proxyServer ??
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy;
  if (server === undefined || server.trim() === '') return undefined;

  const bypass = options.noProxy ?? process.env.NO_PROXY ?? process.env.no_proxy;
  return {
    server: server.trim(),
    ...(bypass !== undefined && bypass.trim() !== '' ? { bypass: bypass.trim() } : {}),
  };
}

export async function launchBrowser(options: LaunchOptions = {}): Promise<Browser> {
  const executablePath = options.executablePath ?? process.env[BROWSER_EXECUTABLE_ENV];
  const proxy = resolveProxy(options);
  try {
    return await chromium.launch({
      headless: options.headed !== true,
      ...(executablePath !== undefined && executablePath !== '' ? { executablePath } : {}),
      ...(proxy !== undefined ? { proxy } : {}),
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
