import { silentLogger, type Logger } from '../shared/logger.js';

/**
 * Pre-run health check.
 *
 * A master-plan exit criterion: "env failures (app down, bad base URL) detected
 * pre-run via health check and reported as env, never 'repaired'". Without it,
 * a stopped server produces a suite full of failures that all look like the
 * tests' fault, and a repair loop would happily rewrite correct tests to work
 * around a machine that is simply off.
 *
 * Checking first — rather than classifying afterwards — matters because it is
 * the difference between "your app is down" as the headline and as something a
 * human has to infer from twelve stack traces.
 */

export interface HealthResult {
  healthy: boolean;
  /** What was checked, in a form worth printing. */
  detail: string;
}

export interface HealthOptions {
  baseUrl: string;
  timeoutMs?: number;
  logger?: Logger;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Is the application answering at all?
 *
 * Deliberately permissive about *what* it answers. Any HTTP response — 200,
 * 302, even 500 — proves a server is listening and the URL is well-formed,
 * which is all this check is for. A 500 is the application's problem to fail
 * on in a test, and calling it an env failure here would suppress a real
 * finding.
 *
 * Only a transport-level failure (refused, DNS, TLS, timeout) means "there is
 * nothing to test against".
 */
export async function checkHealth(options: HealthOptions): Promise<HealthResult> {
  const logger = options.logger ?? silentLogger();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? globalThis.fetch;

  let url: URL;
  try {
    url = new URL(options.baseUrl);
  } catch {
    return {
      healthy: false,
      detail: `baseUrl is not a valid absolute URL: ${options.baseUrl}`,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await doFetch(url.href, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
    });
    logger.debug({ baseUrl: url.href, status: response.status }, 'verify: health check');
    return {
      healthy: true,
      detail: `${url.href} answered ${response.status}`,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const timedOut = controller.signal.aborted;
    return {
      healthy: false,
      detail: timedOut
        ? `${url.href} did not answer within ${timeoutMs}ms`
        : `${url.href} is unreachable: ${reason}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
