import type { BrowserContext, Page as PwPage } from '@playwright/test';
import type { Logger } from '../shared/logger.js';
import { silentLogger } from '../shared/logger.js';
import type { FlintConfig } from '../schemas/config.js';
import type { Page, ScreenModel } from '../schemas/screen-model.js';
import { basename, join } from 'node:path';
import { extractPage, pageId } from './extractor.js';
import { knownLoginUrl, looksLikeLoginWall } from './auth.js';
import { runInteractionPass } from './interaction-pass.js';
import { discoverClientRoutes } from './route-discovery.js';
import { waitForDomStable } from './wait.js';
import {
  decideScope,
  dedupeKey,
  normalizePath,
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
  /**
   * Extra entry points seeded alongside `startUrl`. The CLI uses this to keep
   * modelling `baseUrl` (typically the sign-in page) after redirecting the
   * primary entry point to wherever the login landed — a test generator needs
   * the login screen in the model to generate a login test.
   */
  alsoCrawl?: string[];
  /** Role tag for multi-role exploration. */
  role?: string;
  /** Directory for screenshots; omitted = none. */
  screenshotDir?: string;
  /** Run the bounded modal/menu interaction pass. Defaults to true. */
  interactionPass?: boolean;
  /**
   * Discover client-side routes by clicking links that have no navigable
   * href. Defaults to true, and only runs on pages that offered the crawler
   * no in-scope href at all — server-rendered apps never pay for it.
   */
  routeDiscovery?: boolean;
  /**
   * Log back in when the session expires mid-crawl. Supplied by the caller,
   * which is what owns the auth configuration; the crawler only decides *when*
   * to call it, and calls it at most once.
   */
  reauth?: () => Promise<void>;
}

/** A page the crawler chose not to visit, and why. */
export interface SkippedUrl {
  url: string;
  reason: RejectReason | 'captcha' | 'nav-failed' | 'budget' | 'aborted' | 'duplicate-pattern';
  detail?: string;
}

export interface CrawlResult {
  model: ScreenModel;
  skipped: SkippedUrl[];
  /** Wall-clock duration, for the <5min/30page exit criterion. */
  durationMs: number;
  /**
   * Set when the crawl almost certainly stopped at a login wall rather than
   * genuinely finishing. Without this the user sees "Explored 1 page" and has
   * no way to tell a one-page app from an app they never got into.
   */
  loginWallSuspected?: LoginWallDiagnosis;
  /** Set when a login wall appeared *after* the crawl had already got in. */
  sessionExpiry?: SessionExpiry;
}

export interface LoginWallDiagnosis {
  url: string;
  /** The configured auth mode at the time of the crawl. */
  authMode: string;
  reason: string;
}

export interface SessionExpiry {
  /** The page on which the login wall reappeared. */
  url: string;
  /** Whether the single permitted re-auth attempt succeeded. */
  recovered: boolean;
  /** Why re-auth failed, when it did. */
  detail?: string;
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
  const seeds = [startUrl, ...(options.alsoCrawl ?? [])];
  const queue: QueueItem[] = [];
  const seen = new Set<string>();
  for (const seed of seeds) {
    const key = dedupeKey(seed, policy.normalize);
    if (seen.has(key)) continue;
    seen.add(key);
    queue.push({ url: seed, depth: 0, href: seed });
  }
  const pages: Page[] = [];
  const skipped: SkippedUrl[] = [];
  /**
   * Page ids already captured or queued. Page identity is the *normalized
   * path*, while the frontier dedupes on path + query — so `/item?id=1` and
   * `/item?id=2` are two frontier entries that would become two pages sharing
   * one id. The master plan wants one representative page per pattern, so the
   * pattern is tracked separately and the duplicates never enter the model.
   */
  const claimedPageIds = new Set<string>(
    queue.map((q) => pageId(normalizePath(q.url, policy.normalize), options.role)),
  );

  // The app's own sign-in page is a login wall by every DOM signal, but it is
  // not session expiry — it is a page the crawl is meant to model.
  const loginUrl = knownLoginUrl(config);

  let loginWallSuspected: LoginWallDiagnosis | undefined;
  let sessionExpiry: SessionExpiry | undefined;
  let reauthUsed = false;

  const visitContext: VisitContext = {
    config,
    policy,
    logger,
    interactionPass: options.interactionPass !== false,
    routeDiscovery: options.routeDiscovery !== false,
    ...(options.role !== undefined ? { role: options.role } : {}),
    ...(options.screenshotDir !== undefined ? { screenshotDir: options.screenshotDir } : {}),
  };

  const page = await context.newPage();
  try {
    while (queue.length > 0 && pages.length < explorer.maxPages) {
      const item = queue.shift()!;
      let captured = await visit(page, item, visitContext);

      if (captured.kind === 'skipped') {
        skipped.push(captured.skip);
        continue;
      }

      // A login wall on a page we had already got past means the session died.
      // The master plan allows exactly one re-auth, then continue; if that
      // fails the crawl stops and keeps the partial model.
      //
      // Only meaningful when a session exists to expire. Crawled anonymously,
      // an app's /login and /register pages are ordinary content — treating
      // their password fields as expiry would abort the crawl of any app that
      // links to its own sign-in page (Conduit does, from every navbar).
      if (
        config.auth.mode !== 'none' &&
        item.depth > 0 &&
        !isSameUrlPath(item.url, loginUrl) &&
        (await looksLikeLoginWall(page).catch(() => false))
      ) {
        if (reauthUsed || options.reauth === undefined) {
          sessionExpiry = {
            url: item.url,
            recovered: false,
            detail:
              options.reauth === undefined
                ? 'no re-authentication callback was supplied'
                : 'the session expired again after one re-authentication',
          };
          logger.warn({ url: item.url }, 'session expired — stopping with a partial model');
          break;
        }
        reauthUsed = true;
        logger.warn({ url: item.url }, 'session expired mid-crawl — re-authenticating once');
        try {
          await options.reauth();
        } catch (err) {
          sessionExpiry = {
            url: item.url,
            recovered: false,
            detail: err instanceof Error ? err.message : String(err),
          };
          break;
        }
        sessionExpiry = { url: item.url, recovered: true };
        captured = await visit(page, item, visitContext);
        if (captured.kind === 'skipped') {
          skipped.push(captured.skip);
          continue;
        }
      }

      // A redirect can land on a pattern already represented; keep the first
      // capture and record the rest rather than emitting duplicate page ids.
      if (pages.some((p) => p.id === captured.page.id)) {
        skipped.push({
          url: item.url,
          reason: 'duplicate-pattern',
          detail: captured.page.urlPattern,
        });
        if (item.depth < explorer.maxDepth) {
          enqueueTargets(captured.page, item, {
            queue,
            seen,
            claimedPageIds,
            policy,
            skipped,
            ...(options.role !== undefined ? { role: options.role } : {}),
          });
        }
        continue;
      }

      pages.push(captured.page);
      logger.info(
        { url: item.url, elements: captured.page.elements.length, depth: item.depth },
        'page captured',
      );

      // Diagnose the entry page only: if the app's front door is a login wall,
      // every page this crawl reports is a login screen and the page count is
      // actively misleading. `pages.length === 1` means this was the first
      // capture — the primary seed, not the extra ones seeded beside it.
      if (item.depth === 0 && pages.length === 1) {
        loginWallSuspected = await diagnoseLoginWall(page, item.url, config);
        if (loginWallSuspected !== undefined) {
          logger.warn(
            { url: item.url, authMode: loginWallSuspected.authMode },
            'login wall suspected on the entry page',
          );
        }
      }

      if (item.depth >= explorer.maxDepth) continue;
      enqueueTargets(captured.page, item, {
        queue,
        seen,
        claimedPageIds,
        policy,
        skipped,
        ...(options.role !== undefined ? { role: options.role } : {}),
      });
    }

    // Anything still queued was cut short — report, never hide. Distinguish a
    // clean budget stop from an abort, or a truncated model reads as complete.
    const leftoverReason = sessionExpiry?.recovered === false ? 'aborted' : 'budget';
    for (const leftover of queue) {
      skipped.push({ url: leftover.url, reason: leftoverReason });
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
    ...(loginWallSuspected !== undefined ? { loginWallSuspected } : {}),
    ...(sessionExpiry !== undefined ? { sessionExpiry } : {}),
  };
}

/** Same origin and same path — query and fragment are not identity here. */
function isSameUrlPath(url: string, other: string | undefined): boolean {
  if (other === undefined) return false;
  try {
    const a = new URL(url);
    const b = new URL(other);
    return a.origin === b.origin && a.pathname.replace(/\/$/, '') === b.pathname.replace(/\/$/, '');
  } catch {
    return false;
  }
}

/**
 * Decide whether the crawler is staring at a login screen rather than the app.
 *
 * A visible password field on the entry page means one of two things, and both
 * are worth saying out loud: auth was never configured, or it was configured
 * but did not carry into the crawl.
 */
async function diagnoseLoginWall(
  page: PwPage,
  url: string,
  config: FlintConfig,
): Promise<LoginWallDiagnosis | undefined> {
  if (!(await looksLikeLoginWall(page).catch(() => false))) return undefined;
  const authMode = config.auth.mode;
  const reason =
    authMode === 'none'
      ? 'A password field is visible on the entry page and auth.mode is "none", so the crawl never got past the login screen.'
      : `A password field is still visible on the entry page even though auth.mode is "${authMode}", so the session did not carry into the crawl.`;
  return { url, authMode, reason };
}

type VisitResult = { kind: 'page'; page: Page } | { kind: 'skipped'; skip: SkippedUrl };

interface VisitContext {
  config: FlintConfig;
  policy: UrlPolicyOptions;
  logger: Logger;
  interactionPass: boolean;
  routeDiscovery: boolean;
  role?: string;
  screenshotDir?: string;
}

async function visit(page: PwPage, item: QueueItem, ctx: VisitContext): Promise<VisitResult> {
  const { config } = ctx;
  try {
    await page.goto(item.url, { waitUntil: waitUntilFor(config.explorer.waitStrategy) });
    // `networkidle` is not enough for a client-rendered app: the route may
    // still be painting after the network goes quiet. Wait on the DOM itself.
    await waitForDomStable(page);
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

  const normalizeRules = ctx.policy.normalize ?? [];
  const id = pageId(normalizePath(page.url(), normalizeRules), ctx.role);

  const captured = await extractPage(page, {
    i18n: config.explorer.i18n,
    logger: ctx.logger,
    normalizeRules,
    reachedVia:
      item.depth === 0
        ? { kind: 'link', href: item.href }
        : {
            kind: 'link',
            href: item.href,
            ...(item.fromPageId !== undefined ? { fromPageId: item.fromPageId } : {}),
          },
    ...(ctx.role !== undefined ? { role: ctx.role } : {}),
    ...(ctx.screenshotDir !== undefined
      ? {
          screenshotPath: join(ctx.screenshotDir, `${id}.png`),
          // Stored relative to the model file's directory, which is the parent
          // of the screenshot directory — keeps a committed model portable.
          screenshotRef: `${basename(ctx.screenshotDir)}/${id}.png`,
        }
      : {}),
  });

  const withRoutes = await addClientRoutes(page, captured, ctx);
  if (!ctx.interactionPass) return { kind: 'page', page: withRoutes };
  const captured2 = withRoutes;

  // Second pass: open menus and modals so their contents make it into the
  // model. Bounded to one interaction deep, and never touches a trigger on the
  // dangerous-action denylist.
  const pass = await runInteractionPass(page, captured2.elements, {
    dangerousActionPatterns: config.explorer.dangerousActionPatterns,
    i18n: config.explorer.i18n,
    logger: ctx.logger,
  }).catch(() => undefined);

  if (pass === undefined || pass.revealed.length === 0) return { kind: 'page', page: captured2 };
  ctx.logger.info(
    { url: item.url, revealed: pass.revealed.length },
    'interaction pass revealed additional elements',
  );
  return {
    kind: 'page',
    page: { ...captured2, elements: [...captured2.elements, ...pass.revealed] },
  };
}

/**
 * Add client-side routes to a page's nav targets.
 *
 * Only runs when the page handed the crawler nothing navigable. A page with
 * real same-origin hrefs is a server-rendered page and needs no clicking —
 * which keeps the cost of this off every ordinary crawl.
 */
async function addClientRoutes(page: PwPage, captured: Page, ctx: VisitContext): Promise<Page> {
  if (!ctx.routeDiscovery) return captured;
  const navigable = captured.navTargets.filter(
    (href) => decideScope(href, ctx.policy, captured.url).inScope,
  );
  if (navigable.length > 0) return captured;

  const routes = await discoverClientRoutes(page, {
    dangerousActionPatterns: ctx.config.explorer.dangerousActionPatterns,
    logger: ctx.logger,
  }).catch(() => []);
  if (routes.length === 0) return captured;

  ctx.logger.info(
    { url: captured.url, routes: routes.length },
    'discovered client-side routes on a page with no navigable links',
  );
  return {
    ...captured,
    navTargets: [...new Set([...captured.navTargets, ...routes.map((r) => r.url)])].sort((a, b) =>
      a.localeCompare(b),
    ),
  };
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
  /** Page ids already captured or queued — see `claimedPageIds` in `crawl`. */
  claimedPageIds: Set<string>;
  policy: UrlPolicyOptions;
  skipped: SkippedUrl[];
  role?: string;
}

/**
 * Add a page's nav targets to the frontier. Every target passes through
 * `decideScope`, so the same-origin lock and the include/exclude patterns are
 * enforced in exactly one place.
 */
function enqueueTargets(captured: Page, item: QueueItem, ctx: EnqueueContext): void {
  for (const href of captured.navTargets) {
    const decision = decideScope(href, ctx.policy, captured.url);
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

    // Collapse parameterised URLs before spending a page load on them: six
    // `/inventory-item.html?id=N` links are one page in the model, so only the
    // first is worth visiting.
    const prospectiveId = pageId(normalizePath(decision.url, ctx.policy.normalize), ctx.role);
    if (ctx.claimedPageIds.has(prospectiveId)) {
      ctx.skipped.push({ url: decision.url, reason: 'duplicate-pattern' });
      continue;
    }
    ctx.claimedPageIds.add(prospectiveId);

    ctx.queue.push({
      url: decision.url,
      depth: item.depth + 1,
      fromPageId: captured.id,
      href,
    });
  }
}
