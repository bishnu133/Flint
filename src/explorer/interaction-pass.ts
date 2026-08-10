import type { Locator, Page as PwPage } from '@playwright/test';
import type { Element } from '../schemas/screen-model.js';
import { silentLogger, type Logger } from '../shared/logger.js';
import { extractFrameElements } from './extractor.js';
import { recordRoutes, waitForDomStable } from './wait.js';

/**
 * Bounded two-pass extraction for dynamic content.
 *
 * Menus, dropdowns and modals do not exist in the DOM until something opens
 * them, so a single snapshot can never see them. This pass opens each popup
 * trigger, re-snapshots, and closes it again — **one interaction deep**, which
 * is the V1 bound in the master plan.
 *
 * Two rules keep it safe:
 *   - a trigger whose accessible text matches `dangerousActionPatterns` is
 *     never clicked (logout, delete, submit, pay, …);
 *   - if a click navigates instead of opening something, the pass restores the
 *     original page before continuing — the crawl's page budget and link graph
 *     must not be perturbed by exploration of a popup.
 */

/** Attributes that mark an element as opening something. */
const OPENER_SELECTOR = [
  '[aria-haspopup]',
  '[aria-expanded="false"]',
  '[data-toggle]',
  '[data-bs-toggle]',
].join(', ');

export interface InteractionPassOptions {
  /** Trigger text that must never be clicked. Case-insensitive substrings. */
  dangerousActionPatterns: string[];
  /** Hard cap on triggers tried per page. */
  maxOpeners?: number;
  testIdAttribute?: string;
  i18n?: boolean;
  logger?: Logger;
}

export type OpenerSkipReason =
  'dangerous' | 'not-interactable' | 'nothing-revealed' | 'navigated' | 'failed';

export interface OpenerOutcome {
  /** Accessible text of the trigger, for logs and future provenance. */
  opener: string;
  revealed: Element[];
  skipped?: OpenerSkipReason;
}

export interface InteractionPassResult {
  /** Newly discovered elements, in trigger order then extraction order. */
  revealed: Element[];
  outcomes: OpenerOutcome[];
}

const DEFAULT_MAX_OPENERS = 8;
const OPEN_TIMEOUT_MS = 2_000;
const SETTLE_MS = 1_200;

/**
 * Run the interaction pass over a page that has already been extracted once.
 *
 * `alreadyCaptured` is the first pass's element ids; anything not in that set
 * after a trigger is opened is genuinely new.
 */
export async function runInteractionPass(
  page: PwPage,
  alreadyCaptured: Set<string>,
  options: InteractionPassOptions,
): Promise<InteractionPassResult> {
  const logger = options.logger ?? silentLogger();
  const maxOpeners = options.maxOpeners ?? DEFAULT_MAX_OPENERS;
  const baselineUrl = page.url();

  const openers = await findOpeners(page, maxOpeners);
  const revealed: Element[] = [];
  const outcomes: OpenerOutcome[] = [];
  // Shared across triggers so two menus containing the same item record it once.
  const seenIds = new Set(alreadyCaptured);

  for (const opener of openers) {
    const outcome = await tryOpener(page, opener, {
      ...options,
      logger,
      seenIds,
      baselineUrl,
    });
    outcomes.push(outcome);
    revealed.push(...outcome.revealed);
  }

  return { revealed, outcomes };
}

interface Opener {
  locator: Locator;
  text: string;
}

/**
 * Collect popup triggers in document order, capped.
 *
 * Document order is what Playwright's `all()` returns, and it is stable for an
 * unchanged page — which is what keeps a re-crawl byte-identical.
 */
async function findOpeners(page: PwPage, limit: number): Promise<Opener[]> {
  const locators = await page
    .locator(OPENER_SELECTOR)
    .all()
    .catch(() => []);
  const out: Opener[] = [];
  for (const locator of locators.slice(0, limit)) {
    const text = await accessibleText(locator);
    out.push({ locator, text });
  }
  return out;
}

async function accessibleText(locator: Locator): Promise<string> {
  const parts = await Promise.all([
    locator.getAttribute('aria-label').catch(() => null),
    locator.innerText().catch(() => ''),
    locator.getAttribute('title').catch(() => null),
  ]);
  return (parts.find((p) => p !== null && p.trim() !== '') ?? '').trim().slice(0, 80);
}

interface TryOpenerContext extends InteractionPassOptions {
  logger: Logger;
  seenIds: Set<string>;
  baselineUrl: string;
}

async function tryOpener(
  page: PwPage,
  opener: Opener,
  ctx: TryOpenerContext,
): Promise<OpenerOutcome> {
  if (isDangerous(opener.text, ctx.dangerousActionPatterns)) {
    ctx.logger.debug({ opener: opener.text }, 'interaction pass: trigger on the denylist');
    return { opener: opener.text, revealed: [], skipped: 'dangerous' };
  }

  const interactable = await isInteractable(opener.locator);
  if (!interactable) return { opener: opener.text, revealed: [], skipped: 'not-interactable' };

  const routes = recordRoutes(page);
  const clicked = await opener.locator
    .click({ timeout: OPEN_TIMEOUT_MS })
    .then(() => true)
    .catch(() => false);
  if (!clicked) {
    routes.stop();
    return { opener: opener.text, revealed: [], skipped: 'failed' };
  }
  await waitForDomStable(page, { timeoutMs: SETTLE_MS });

  const navigated = routes.changed();
  routes.stop();
  if (navigated) {
    // The trigger was a link in disguise. Put the page back before moving on;
    // the crawler owns the link graph, not this pass.
    await restore(page, ctx.baselineUrl);
    return { opener: opener.text, revealed: [], skipped: 'navigated' };
  }

  const revealed = await extractFrameElements(page.mainFrame(), {
    ...(ctx.testIdAttribute !== undefined ? { testIdAttribute: ctx.testIdAttribute } : {}),
    ...(ctx.i18n !== undefined ? { i18n: ctx.i18n } : {}),
    seenIds: ctx.seenIds,
  }).catch(() => [] as Element[]);

  await close(page, opener, ctx.baselineUrl);

  if (revealed.length === 0) {
    return { opener: opener.text, revealed: [], skipped: 'nothing-revealed' };
  }
  ctx.logger.debug(
    { opener: opener.text, revealed: revealed.length },
    'interaction pass: elements revealed',
  );
  return { opener: opener.text, revealed };
}

/** Substring match, case-insensitive — the same shape as the config examples. */
export function isDangerous(text: string, patterns: string[]): boolean {
  const haystack = text.toLowerCase();
  return patterns.some((p) => p !== '' && haystack.includes(p.toLowerCase()));
}

async function isInteractable(locator: Locator): Promise<boolean> {
  const [count, visible, enabled] = await Promise.all([
    locator.count().catch(() => 0),
    locator.isVisible().catch(() => false),
    locator.isEnabled().catch(() => false),
  ]);
  return count === 1 && visible && enabled;
}

/**
 * Put the popup away. Escape closes the overwhelming majority of menus and
 * dialogs; clicking the trigger again handles the toggles it does not. If the
 * page is still not where it started, reload — the next trigger has to start
 * from the same baseline or the diff is meaningless.
 */
async function close(page: PwPage, opener: Opener, baselineUrl: string): Promise<void> {
  await page.keyboard.press('Escape').catch(() => undefined);
  await waitForDomStable(page, { timeoutMs: SETTLE_MS });

  const expanded = await opener.locator
    .getAttribute('aria-expanded')
    .catch(() => null)
    .then((v) => v === 'true');
  if (expanded) {
    await opener.locator.click({ timeout: OPEN_TIMEOUT_MS }).catch(() => undefined);
    await waitForDomStable(page, { timeoutMs: SETTLE_MS });
  }

  if (page.url() !== baselineUrl) await restore(page, baselineUrl);
}

async function restore(page: PwPage, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
  await waitForDomStable(page, { timeoutMs: SETTLE_MS });
}
