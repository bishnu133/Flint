import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import { loadConfig } from '../../config/load.js';
import { createLogger } from '../../shared/logger.js';
import { FlintError } from '../../shared/errors.js';
import { launchBrowser } from '../../explorer/browser.js';
import { createAuthenticatedContext, reauthenticate } from '../../explorer/auth.js';
import { crawl, type LoginWallDiagnosis, type SessionExpiry } from '../../explorer/crawler.js';
import {
  diffModels,
  formatDiff,
  modelPath,
  readModel,
  tryReadModel,
  writeModel,
} from '../../explorer/screen-model-store.js';
import { validateModel, formatValidation } from '../../explorer/validator.js';
import { isSameOrigin } from '../../explorer/url-policy.js';
import {
  formatReplay,
  mergeFlowPages,
  replayFlows,
  type ReplayResult,
} from '../../explorer/flows.js';

/**
 * `flint explore` — build the Screen Model by exploring the live app.
 *
 * Refuses to run against a non-test envClass: exploration navigates a real
 * browser through a real app, and the master plan's safety rails exist because
 * that is only ever acceptable on a disposable environment.
 */
export function registerExplore(program: Command): void {
  program
    .command('explore')
    .description('Build the Screen Model by exploring the live app')
    .option('-d, --dir <dir>', 'project directory', '.')
    .option('-u, --url <url>', 'override the crawl entry point')
    .option('--max-pages <n>', 'override explorer.maxPages', parseIntArg)
    .option('--max-depth <n>', 'override explorer.maxDepth', parseIntArg)
    .option('--role <role>', 'capture the model for a named role')
    .option('--diff', 'compare against the stored model instead of replacing it', false)
    .option(
      '--validate',
      're-resolve every stored top selector and report the break rate (no crawl)',
      false,
    )
    .option(
      '--min-resolve-rate <pct>',
      'with --validate, fail below this percentage',
      parseIntArg,
      95,
    )
    .option('--headed', 'run with a visible browser window', false)
    .option('--no-interaction-pass', 'skip opening menus/modals to catch hidden elements')
    .option('--no-route-discovery', 'skip clicking href-less links to find client-side routes')
    .option('--no-flows', 'skip replaying the flow scripts in <kbDir>/app/flows')
    .option('--flow <id...>', 'replay only the named flow scripts')
    .option('-v, --verbose', 'verbose logging', false)
    .action(async (opts: ExploreOptions) => {
      await runExplore(opts);
    });
}

interface ExploreOptions {
  dir: string;
  url?: string;
  maxPages?: number;
  maxDepth?: number;
  role?: string;
  diff: boolean;
  validate: boolean;
  minResolveRate: number;
  headed: boolean;
  /** commander maps `--no-interaction-pass` onto this, defaulting to true. */
  interactionPass: boolean;
  /** commander maps `--no-route-discovery` onto this, defaulting to true. */
  routeDiscovery: boolean;
  /** commander maps `--no-flows` onto this, defaulting to true. */
  flows: boolean;
  flow?: string[];
  verbose: boolean;
}

function parseIntArg(value: string): number {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n <= 0) {
    throw new FlintError(`Expected a positive integer, got "${value}".`, { code: 'CLI' });
  }
  return n;
}

async function runExplore(opts: ExploreOptions): Promise<void> {
  const projectRoot = resolve(process.cwd(), opts.dir);
  const logger = createLogger({ verbose: opts.verbose });
  const { config } = await loadConfig(projectRoot);

  // Safety rail: exploration drives a real browser through a real app.
  if (config.envClass !== 'test') {
    throw new FlintError(`Refusing to explore an envClass of "${config.envClass}".`, {
      code: 'SAFETY',
      hint: 'Exploration is only allowed against envClass "test". Point baseUrl at a disposable environment.',
    });
  }

  const effective = {
    ...config,
    explorer: {
      ...config.explorer,
      ...(opts.maxPages !== undefined ? { maxPages: opts.maxPages } : {}),
      ...(opts.maxDepth !== undefined ? { maxDepth: opts.maxDepth } : {}),
    },
  };

  const screenshotDir = join(projectRoot, '.flint', 'screen-model', 'screenshots');
  mkdirSync(screenshotDir, { recursive: true });

  const browser = await launchBrowser({ headed: opts.headed });
  try {
    const { context, landingUrl } = await createAuthenticatedContext(browser, {
      config,
      projectRoot,
      logger,
    });

    // --validate replays the stored model; it does not crawl.
    if (opts.validate) {
      const stored = readModel(modelPath(projectRoot, opts.role));
      const report = await validateModel(context, stored, { logger });
      console.log('');
      console.log(formatValidation(report));
      const pct = report.resolveRate * 100;
      const threshold = opts.minResolveRate;
      console.log('');
      // "100% of nothing" is not a pass. An empty or unreachable model must
      // never report green — that is exactly how a broken crawl hides.
      if (report.selectorsChecked === 0) {
        console.log('FAIL: nothing to validate — the stored model has no resolvable selectors.');
        console.log('      Re-run `flint explore` and check it captured pages.');
        process.exitCode = 1;
      } else if (pct + 1e-9 < threshold) {
        console.log(`FAIL: resolve rate ${pct.toFixed(1)}% is below the ${threshold}% threshold.`);
        process.exitCode = 1;
      } else {
        console.log(`PASS: resolve rate ${pct.toFixed(1)}% meets the ${threshold}% threshold.`);
      }
      return;
    }

    // Where to start. An app's baseUrl is very often its sign-in page, and
    // logging in does not change that — crawling from it after a successful
    // login just re-lands on the form. Start where the login landed instead,
    // and seed baseUrl alongside so the sign-in page is still modelled.
    const entry = chooseEntryPoint(opts.url, landingUrl, config.baseUrl);
    const alsoCrawl = entry === config.baseUrl ? [] : [config.baseUrl];
    if (entry !== config.baseUrl && opts.url === undefined) {
      console.log(`Starting from the post-login page: ${entry}`);
    }

    const result = await crawl(context, {
      config: effective,
      logger,
      startUrl: entry,
      ...(alsoCrawl.length > 0 ? { alsoCrawl } : {}),
      ...(opts.role !== undefined ? { role: opts.role } : {}),
      screenshotDir,
      interactionPass: opts.interactionPass,
      routeDiscovery: opts.routeDiscovery,
      reauth: () => reauthenticate(context, { config, projectRoot, logger }),
    });

    // Flow scripts reach states no link leads to, so they run after the crawl
    // and fold their pages into the same model.
    let model = result.model;
    let replay: ReplayResult | undefined;
    if (opts.flows) {
      replay = await replayFlows(context, {
        config,
        projectRoot,
        logger,
        ...(opts.role !== undefined ? { role: opts.role } : {}),
        ...(opts.flow !== undefined ? { only: opts.flow } : {}),
      });
      model = mergeFlowPages(model, replay.pages);
    }

    const path = modelPath(projectRoot, opts.role);
    const previous = tryReadModel(path);

    console.log('');
    console.log(`Explored ${model.pages.length} page(s) in ${fmtDuration(result.durationMs)}`);
    console.log(`  elements captured: ${countElements(model)}`);
    console.log(`  verified unique selectors: ${countUniqueSelectors(model)}`);
    if (result.skipped.length > 0) {
      console.log(`  skipped: ${result.skipped.length} (${summarizeSkips(result.skipped)})`);
    }

    if (result.loginWallSuspected !== undefined) {
      printLoginWallWarning(result.loginWallSuspected, config.baseUrl);
    }
    if (result.sessionExpiry !== undefined) {
      printSessionExpiry(result.sessionExpiry);
    }
    if (replay !== undefined && (replay.succeeded.length > 0 || replay.failures.length > 0)) {
      console.log('');
      console.log(formatReplay(replay));
      // A broken flow means a state nobody modelled — surface it in CI.
      if (replay.failures.length > 0) process.exitCode = 1;
    }

    if (opts.diff) {
      if (previous === undefined) {
        console.log('\nNo stored model to diff against — run without --diff first.');
        process.exitCode = 1;
        return;
      }
      const diff = diffModels(previous, model);
      console.log('\nDiff vs stored model:');
      console.log(formatDiff(diff));
      // Non-zero on drift so CI can gate on it.
      process.exitCode = diff.unchanged ? 0 : 1;
      return;
    }

    if (model.pages.length === 0) {
      console.log('\nFAIL: no pages were captured — nothing was written.');
      console.log(`  entry point: ${entry}`);
      const navFailed = result.skipped.find((s) => s.reason === 'nav-failed');
      if (navFailed !== undefined) {
        console.log(`  the entry point could not be loaded: ${navFailed.detail ?? ''}`);
        console.log('  check baseUrl in flint.config.ts, and that the app is reachable.');
      }
      // Refuse to replace a good stored model with an empty one.
      process.exitCode = 1;
      return;
    }

    writeModel(path, model);
    console.log(`\nScreen Model written to ${path}`);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/**
 * A one-page result behind a login wall looks exactly like a one-page app.
 * Say which one it is, and say how to fix it, rather than leaving the user to
 * infer it from a page count.
 */
function printLoginWallWarning(diagnosis: LoginWallDiagnosis, baseUrl: string): void {
  console.log('');
  console.log('WARNING: login wall suspected — this model is probably the login screen,');
  console.log('         not your application.');
  console.log(`  ${diagnosis.reason}`);
  console.log(`  entry page: ${diagnosis.url}`);
  if (diagnosis.authMode === 'none') {
    console.log('  fix: configure auth in flint.config.ts, for example');
    console.log('       auth: {');
    console.log("         mode: 'credentials',");
    console.log("         username: process.env.APP_USER ?? '',");
    console.log("         password: process.env.APP_PASSWORD ?? '',");
    console.log(`         loginUrl: '${trimSlash(baseUrl)}/login',`);
    console.log('       },');
  } else {
    console.log('  fix: check the credentials/session used by auth, then re-run explore.');
  }
}

/**
 * A partial model is useful; a partial model mistaken for a complete one is
 * not. Say which happened, and set a non-zero exit code when the crawl aborted
 * so CI does not treat a truncated model as a good run.
 */
function printSessionExpiry(expiry: SessionExpiry): void {
  console.log('');
  if (expiry.recovered) {
    console.log('NOTE: the session expired mid-crawl; Flint logged back in and continued.');
    console.log(`  first seen on: ${expiry.url}`);
    return;
  }
  console.log('WARNING: the session expired mid-crawl and could not be restored.');
  console.log('         The model below is PARTIAL.');
  console.log(`  stopped at: ${expiry.url}`);
  if (expiry.detail !== undefined) console.log(`  reason: ${expiry.detail}`);
  process.exitCode = 1;
}

/**
 * `--url` always wins; then the post-login landing page, but only when it is
 * same-origin with the configured app (an SSO hop can land anywhere, and the
 * crawler is origin-locked).
 */
function chooseEntryPoint(
  override: string | undefined,
  landingUrl: string | undefined,
  baseUrl: string,
): string {
  if (override !== undefined) return override;
  if (landingUrl !== undefined && isSameOrigin(landingUrl, baseUrl)) return landingUrl;
  return baseUrl;
}

function trimSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function countElements(model: { pages: Array<{ elements: unknown[] }> }): number {
  return model.pages.reduce((sum, p) => sum + p.elements.length, 0);
}

function countUniqueSelectors(model: {
  pages: Array<{
    elements: Array<{ selectorCandidates: Array<{ unique: boolean; verified: boolean }> }>;
  }>;
}): number {
  let n = 0;
  for (const page of model.pages) {
    for (const el of page.elements) {
      if (el.selectorCandidates.some((c) => c.verified && c.unique)) n += 1;
    }
  }
  return n;
}

function summarizeSkips(skipped: Array<{ reason: string }>): string {
  const counts = new Map<string, number>();
  for (const s of skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([reason, n]) => `${reason}: ${n}`)
    .join(', ');
}

function fmtDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
