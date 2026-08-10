import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import { loadConfig } from '../../config/load.js';
import { createLogger } from '../../shared/logger.js';
import { FlintError } from '../../shared/errors.js';
import { launchBrowser } from '../../explorer/browser.js';
import { createAuthenticatedContext } from '../../explorer/auth.js';
import { crawl } from '../../explorer/crawler.js';
import {
  diffModels,
  formatDiff,
  modelPath,
  readModel,
  tryReadModel,
  writeModel,
} from '../../explorer/screen-model-store.js';
import { validateModel, formatValidation } from '../../explorer/validator.js';

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
    const context = await createAuthenticatedContext(browser, { config, projectRoot, logger });

    // --validate replays the stored model; it does not crawl.
    if (opts.validate) {
      const stored = readModel(modelPath(projectRoot, opts.role));
      const report = await validateModel(context, stored, { logger });
      console.log('');
      console.log(formatValidation(report));
      const pct = report.resolveRate * 100;
      const threshold = opts.minResolveRate;
      console.log('');
      if (pct + 1e-9 < threshold) {
        console.log(`FAIL: resolve rate ${pct.toFixed(1)}% is below the ${threshold}% threshold.`);
        process.exitCode = 1;
      } else {
        console.log(`PASS: resolve rate ${pct.toFixed(1)}% meets the ${threshold}% threshold.`);
      }
      return;
    }

    const result = await crawl(context, {
      config: effective,
      logger,
      ...(opts.url !== undefined ? { startUrl: opts.url } : {}),
      ...(opts.role !== undefined ? { role: opts.role } : {}),
      screenshotDir,
    });

    const path = modelPath(projectRoot, opts.role);
    const previous = tryReadModel(path);

    console.log('');
    console.log(
      `Explored ${result.model.pages.length} page(s) in ${fmtDuration(result.durationMs)}`,
    );
    console.log(`  elements captured: ${countElements(result)}`);
    console.log(`  verified unique selectors: ${countUniqueSelectors(result)}`);
    if (result.skipped.length > 0) {
      console.log(`  skipped: ${result.skipped.length} (${summarizeSkips(result.skipped)})`);
    }

    if (opts.diff) {
      if (previous === undefined) {
        console.log('\nNo stored model to diff against — run without --diff first.');
        process.exitCode = 1;
        return;
      }
      const diff = diffModels(previous, result.model);
      console.log('\nDiff vs stored model:');
      console.log(formatDiff(diff));
      // Non-zero on drift so CI can gate on it.
      process.exitCode = diff.unchanged ? 0 : 1;
      return;
    }

    writeModel(path, result.model);
    console.log(`\nScreen Model written to ${path}`);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

function countElements(result: { model: { pages: Array<{ elements: unknown[] }> } }): number {
  return result.model.pages.reduce((sum, p) => sum + p.elements.length, 0);
}

function countUniqueSelectors(result: {
  model: {
    pages: Array<{
      elements: Array<{ selectorCandidates: Array<{ unique: boolean; verified: boolean }> }>;
    }>;
  };
}): number {
  let n = 0;
  for (const page of result.model.pages) {
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
