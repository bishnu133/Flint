import type { Frame, Page } from '@playwright/test';

/**
 * Settle heuristics for client-rendered apps.
 *
 * `waitUntil: 'networkidle'` is necessary but not sufficient for an SPA: a
 * route change driven by the history API fires no navigation event and may
 * finish painting after the network has already gone quiet. Everything the
 * extractor reads is only trustworthy once the DOM has stopped moving, so the
 * crawler waits on the DOM itself rather than on a proxy for it.
 */

export interface StabilityOptions {
  /** Give up after this long and extract whatever is on screen. */
  timeoutMs?: number;
  /** Gap between DOM samples. */
  intervalMs?: number;
  /** Consecutive identical samples required to call it stable. */
  requiredStableSamples?: number;
}

export interface StabilityResult {
  stable: boolean;
  /** How long the wait actually took — surfaced so slow pages are visible. */
  waitedMs: number;
  samples: number;
}

const DEFAULTS = {
  timeoutMs: 5_000,
  intervalMs: 150,
  requiredStableSamples: 2,
} as const;

/**
 * Poll the DOM until it stops changing.
 *
 * The fingerprint is node count plus body text length: cheap to compute, and
 * sensitive to the things that actually matter (elements appearing, content
 * filling in) while ignoring attribute churn from animations.
 */
export async function waitForDomStable(
  target: Page | Frame,
  options: StabilityOptions = {},
): Promise<StabilityResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const intervalMs = options.intervalMs ?? DEFAULTS.intervalMs;
  const required = options.requiredStableSamples ?? DEFAULTS.requiredStableSamples;

  const started = Date.now();
  let previous: string | undefined;
  let stableRuns = 0;
  let samples = 0;

  while (Date.now() - started < timeoutMs) {
    const fingerprint = await domFingerprint(target);
    samples += 1;
    if (fingerprint === undefined) {
      // Mid-navigation: the execution context was destroyed. Reset and retry.
      previous = undefined;
      stableRuns = 0;
    } else if (fingerprint === previous) {
      stableRuns += 1;
      if (stableRuns >= required) {
        return { stable: true, waitedMs: Date.now() - started, samples };
      }
    } else {
      previous = fingerprint;
      stableRuns = 0;
    }
    await sleep(intervalMs);
  }

  return { stable: false, waitedMs: Date.now() - started, samples };
}

async function domFingerprint(target: Page | Frame): Promise<string | undefined> {
  return target
    .evaluate(() => {
      const nodes = document.getElementsByTagName('*').length;
      const text = document.body?.innerText.length ?? 0;
      return `${nodes}:${text}`;
    })
    .catch(() => undefined);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Record client-side route changes.
 *
 * An SPA can change its URL without a navigation, and the bounded interaction
 * pass needs to know when a click routed away instead of opening a menu — a
 * routed-away page must not have its post-click DOM attributed to the page the
 * crawler thought it was on.
 */
export interface RouteRecorder {
  /** URLs observed since the recorder was installed, in order. */
  urls(): string[];
  /** True when the URL changed after the recorder was installed. */
  changed(): boolean;
  stop(): void;
}

export function recordRoutes(page: Page): RouteRecorder {
  const start = page.url();
  const seen: string[] = [];
  const onNavigated = (frame: Frame): void => {
    if (frame !== page.mainFrame()) return;
    const url = frame.url();
    if (url !== start && seen[seen.length - 1] !== url) seen.push(url);
  };
  page.on('framenavigated', onNavigated);
  return {
    urls: () => [...seen],
    // page.url() catches history.pushState, which fires no framenavigated in
    // every browser build; the listener catches real navigations. Check both.
    changed: () => seen.length > 0 || page.url() !== start,
    stop: () => page.off('framenavigated', onNavigated),
  };
}
