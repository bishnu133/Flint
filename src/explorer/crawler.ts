import type { BrowserContext, Page as PwPage } from '@playwright/test';
import type { Logger } from '../shared/logger.js';
import { silentLogger } from '../shared/logger.js';
import type { FlintConfig } from '../schemas/config.js';
import type { Page, ScreenModel } from '../schemas/screen-model.js';
import { extractPage } from './extractor.js';
import {
  decideScope,
  dedupeKey,
  policyFromConfig,
  type RejectReason,
  type UrlPolicyOptions,
} from './url-policy.js';

/**
 * BFS crawler.
 *
 * Safety is structural, not advisory: the crawler navigates **only** via
 * `page.goto()` on hrefs it has already vetted. It never clicks. Buttons are
 * catalogued by the extractor but never pressed, which is what makes it safe to
 * point at an app with "Delete account" on screen.
 */

export interface CrawlOptions {
  config: FlintConfig;
  logger?: Logger;
  /** Override the crawl entry point; defaults to `config.baseUrl`. */
  startUrl?: string;
  /** Role tag for multi-role exploration. */
  role?: string;
  /** Directory for screenshots; omitted = none. */
  screenshotDir?: string;
}

/** A page the crawler chose not to visit, and why. */
export interface SkippedUrl {
  url: string;
  reason: RejectReason | 'captcha' | 'nav-failed' | 'budget';
  detail?: string;
}

export interface CrawlResult {
  model: ScreenModel;
  skipped: SkippedUrl[];
  /** Wall-clock duration, for the <5min/30page exit criterion. */
  durationMs: number;
}

interface QueueItem {
  url: string;
  depth: number;
  fromPageId?: string;
  href: string;
}

export async function crawl(context: BrowserContext, options: CrawlOptions): Promise<CrawlResult> {
  const started = Date.now();
  const logger = options.logger ?? silentLogger();
  const { config } = options;
  const policy = policyFromConfig(config);
  const explorer = config.explorer;

  const startUrl = options.startUrl ?? config.baseUrl;
  const queue: QueueItem[] = [{ url: startUrl, depth: 0, href: startUrl }];
  const seen = new Set<string>([dedupeKey(startUrl, policy.normalize)]);
  const pages: Page[] = [];
  const skipped: SkippedUrl[] = [];

  const page = await context.newPage();
  try {
    while (queue.length > 0 && pages.length < explorer.maxPages) {
      const item = queue.shift()!;
      const captured = await visit(page, item, {
        config,
        policy,
        logger,
        role: options.role,
        screenshotDir: options.screenshotDir,
      });

      if (captured.kind === 'skipped') {
        skipped.push(captured.skip);
        continue;
      }
      pages.push(captured.page);
      logger.info(
        { url: item.url, elements: captured.page.elements.length, depth: item.depth },
        'page captured',
      );

      if (item.depth >= explorer.maxDepth) continue;
      enqueueTargets(captured.page, item, { queue, seen, policy, skipped });
    }

    // Anything still queued was cut by the page budget — report, never hide.
    for (const leftover of queue) {
      skipped.push({ url: leftover.url, reason: 'budget' });
    }
  } finally {
    await page.close().catch(() => undefined);
  }

  return {
    model: {
      version: String(Date.now()),
      baseUrl: config.baseUrl,
      capturedAt: new Date().toISOString(),
      pages,
      ...(options.role !== undefined ? { role: options.role } : {}),
    },
    skipped,
    durationMs: Date.now() - started,
  };
}

type VisitResult = { kind: 'page'; page: Page } | { kind: 'skipped'; skip: SkippedUrl };

interface VisitContext {
  config: FlintConfig;
  policy: UrlPolicyOptions;
  logger: Logger;
  role?: string;
  screenshotDir?: string;
}

async function visit(page: PwPage, item: QueueItem, ctx: VisitContext): Promise<VisitResult> {
  const { config } = ctx;
  try {
    await page.goto(item.url, { waitUntil: waitUntilFor(config.explorer.waitStrategy) });
  } catch (err) {
    return {
      kind: 'skipped',
      skip: {
        url: item.url,
        reason: 'nav-failed',
        detail: err instanceof Error ? err.message : String(err),
      },
    };
  }

  // CAPTCHA / bot-wall detection: mark unreachable and keep going, per the
  // master plan. Never try to solve or bypass it.
  const captcha = await detectCaptcha(page, config.explorer.captchaPatterns);
  if (captcha !== undefined) {
    ctx.logger.warn({ url: item.url, pattern: captcha }, 'captcha detected — page skipped');
    return { kind: 'skipped', skip: { url: item.url, reason: 'captcha', detail: captcha } };
  }

  const captured = await extractPage(page, {
    i18n: config.explorer.i18n,
    normalizeRules: ctx.policy.normalize ?? [],
    reachedVia:
      item.depth === 0
        ? { kind: 'link', href: item.href }
        : {
            kind: 'link',
            href: item.href,
            ...(item.fromPageId !== undefined ? { fromPageId: item.fromPageId } : {}),
          },
    ...(ctx.role !== undefined ? { role: ctx.role } : {}),
  });
  return { kind: 'page', page: captured };
}

/** Map the configured wait strategy onto Playwright's goto option. */
export function waitUntilFor(
  strategy: FlintConfig['explorer']['waitStrategy'],
): 'load' | 'domcontentloaded' | 'networkidle' {
  return strategy;
}

/** Look for configured bot-wall markers in the page text. */
async function detectCaptcha(page: PwPage, patterns: string[]): Promise<string | undefined> {
  if (patterns.length === 0) return undefined;
  const body = await page
    .locator('body')
    .innerText()
    .catch(() => '');
  const haystack = body.toLowerCase();
  return patterns.find((p) => haystack.includes(p.toLowerCase()));
}

interface EnqueueContext {
  queue: QueueItem[];
  seen: Set<string>;
  policy: UrlPolicyOptions;
  skipped: SkippedUrl[];
}

/**
 * Add a page's nav targets to the frontier. Every target passes through
 * `decideScope`, so the same-origin lock and the include/exclude patterns are
 * enforced in exactly one place.
 */
function enqueueTargets(captured: Page, item: QueueItem, ctx: EnqueueContext): void {
  for (const href of captured.navTargets) {
    const decision = decideScope(href, ctx.policy);
    if (!decision.inScope) {
      // Cross-origin and unparseable links are normal and high-volume; only
      // record the configured rejections, which a user may want to review.
      if (decision.reason === 'excluded' || decision.reason === 'not-included') {
        ctx.skipped.push({ url: href, reason: decision.reason });
      }
      continue;
    }
    const key = dedupeKey(decision.url, ctx.policy.normalize);
    if (ctx.seen.has(key)) continue;
    ctx.seen.add(key);
    ctx.queue.push({
      url: decision.url,
      depth: item.depth + 1,
      fromPageId: captured.id,
      href,
    });
  }
}
