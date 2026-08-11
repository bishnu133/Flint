import type { Locator, Page as PwPage } from '@playwright/test';
import { silentLogger, type Logger } from '../shared/logger.js';
import { isDangerous } from './interaction-pass.js';
import { waitForDomStable } from './wait.js';

/**
 * Client-side route discovery.
 *
 * A BFS crawl follows `<a href>`. A React/Vue app frequently has no navigable
 * href at all — every link is `<a href="#">` or `<div role="link">` with a
 * click handler that calls the router. saucedemo is one of these: its product
 * and cart links carry no target, so a crawl of the inventory page finds
 * exactly zero pages to visit next and reports the app as three pages.
 *
 * The routes those links lead to are real URLs that respond perfectly well to
 * `goto` — the crawler simply never learns them. This module clicks such a
 * link once, records where the app routed to, and puts the page back. The
 * discovered URL is then handed to the crawler to visit **by navigation**, the
 * ordinary way.
 *
 * The safety model is unchanged in substance. The crawler still only ever
 * `goto`s vetted URLs; this is the master plan's sanctioned bounded-click
 * escape hatch, restricted to elements that are links (never buttons), that
 * are visible (a closed burger menu is not clicked), and whose text does not
 * match `dangerousActionPatterns`.
 */

/** Anchors and ARIA links with nothing for the crawler to navigate to. */
const CLIENT_LINK_SELECTOR = [
  'a:not([href])',
  'a[href=""]',
  'a[href="#"]',
  'a[href^="javascript:"]',
  '[role="link"]:not(a)',
].join(', ');

export interface RouteDiscoveryOptions {
  /** Link text that must never be clicked. */
  dangerousActionPatterns: string[];
  /** Hard cap on links tried per page. */
  maxLinks?: number;
  logger?: Logger;
}

export interface DiscoveredRoute {
  /** The absolute URL the app routed to. */
  url: string;
  /** Accessible text of the link that led there, for logs. */
  via: string;
}

const DEFAULT_MAX_LINKS = 12;
const CLICK_TIMEOUT_MS = 2_000;
const SETTLE_MS = 1_500;

/**
 * Click each client-side link once and collect the URLs they route to.
 *
 * Returns absolute URLs in discovery order, deduplicated. The page is left on
 * the URL it started from.
 */
export async function discoverClientRoutes(
  page: PwPage,
  options: RouteDiscoveryOptions,
): Promise<DiscoveredRoute[]> {
  const logger = options.logger ?? silentLogger();
  const maxLinks = options.maxLinks ?? DEFAULT_MAX_LINKS;
  const baseline = page.url();

  const links = await page
    .locator(CLIENT_LINK_SELECTOR)
    .all()
    .catch(() => []);
  if (links.length === 0) return [];

  const found: DiscoveredRoute[] = [];
  const seen = new Set<string>([baseline]);

  for (const link of links.slice(0, maxLinks)) {
    const text = await accessibleText(link);
    if (isDangerous(text, options.dangerousActionPatterns)) {
      logger.debug({ link: text }, 'route discovery: link on the denylist');
      continue;
    }
    if (!(await isClickable(link))) continue;

    const clicked = await link
      .click({ timeout: CLICK_TIMEOUT_MS })
      .then(() => true)
      .catch(() => false);
    if (!clicked) continue;

    await waitForDomStable(page, { timeoutMs: SETTLE_MS });
    const landed = page.url();

    if (landed !== baseline && !seen.has(landed)) {
      seen.add(landed);
      found.push({ url: landed, via: text });
      logger.debug({ url: landed, via: text }, 'route discovery: found a client-side route');
    }

    // Always restore, whether or not the click routed: it may instead have
    // opened a menu, and the next link has to start from the same page.
    if (page.url() !== baseline) {
      await page.goto(baseline, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
      await waitForDomStable(page, { timeoutMs: SETTLE_MS });
    }
  }

  return found;
}

async function accessibleText(locator: Locator): Promise<string> {
  const parts = await Promise.all([
    locator.getAttribute('aria-label').catch(() => null),
    locator.innerText().catch(() => ''),
    locator.getAttribute('title').catch(() => null),
  ]);
  return (parts.find((p) => p !== null && p.trim() !== '') ?? '').trim().slice(0, 80);
}

async function isClickable(locator: Locator): Promise<boolean> {
  const [visible, enabled] = await Promise.all([
    locator.isVisible().catch(() => false),
    locator.isEnabled().catch(() => false),
  ]);
  return visible && enabled;
}
