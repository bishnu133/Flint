import { resolve } from 'node:path';
import type { Command } from 'commander';
import { loadConfig } from '../../config/load.js';
import { createLogger } from '../../shared/logger.js';
import { scanManifest } from '../../indexer/manifest-scan.js';
import {
  formatManifestSummary,
  manifestPath,
  writeManifest,
} from '../../indexer/manifest-store.js';
import { isEmptyManifest } from '../../schemas/manifest.js';

/**
 * `flint manifest` — inventory what the Bubblegum suite can already do.
 *
 * Static, like `flint index`: reads files, runs nothing, needs no browser and
 * no model. Safe to point at a suite that does not compile.
 *
 * The output is machine input for the planner, not a document anyone should
 * have to read. It is printed as a summary here for one purpose — so a human
 * can glance at it once and say "yes, that is my suite" before trusting the
 * generator to reuse from it.
 */
export function registerManifest(program: Command): void {
  program
    .command('manifest')
    .description('Inventory the existing flows, data, credentials and repositories')
    .option('-d, --dir <dir>', 'project directory', '.')
    .option(
      '--root <path...>',
      'extra directories to scan for credentials and repositories (monorepo packages)',
    )
    .option('--json', 'print the manifest as JSON instead of a summary', false)
    .option('-v, --verbose', 'verbose logging', false)
    .action(async (opts: ManifestOptions) => {
      await runManifest(opts);
    });
}

interface ManifestOptions {
  dir: string;
  root?: string[];
  json: boolean;
  verbose: boolean;
}

async function runManifest(opts: ManifestOptions): Promise<void> {
  const projectRoot = resolve(process.cwd(), opts.dir);
  const logger = createLogger({ verbose: opts.verbose });
  const { config } = await loadConfig(projectRoot);

  const manifest = scanManifest({
    projectRoot,
    suiteDir: config.suiteDir,
    ...(opts.root !== undefined ? { extraRoots: opts.root } : {}),
    logger,
  });

  if (opts.json) {
    console.log(JSON.stringify(manifest, null, 2));
  } else {
    console.log(formatManifestSummary(manifest));
  }

  writeManifest(projectRoot, manifest);

  if (!opts.json) {
    console.log(`\nWritten to ${manifestPath(projectRoot)}`);
    if (isEmptyManifest(manifest)) {
      // Not a warning: an empty manifest is the correct answer for a project
      // that has not generated anything yet, and the first feature will build
      // the login flow along with everything else.
      console.log(
        '\nNothing to reuse yet — this is a new suite. The first generated\n' +
          'feature will create the flows, data and helpers it needs.',
      );
    }
  }
}
