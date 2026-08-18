import { resolve } from 'node:path';
import type { Command } from 'commander';
import { loadConfig } from '../../config/load.js';
import { createLogger } from '../../shared/logger.js';
import { scanManifest } from '../../indexer/manifest-scan.js';
import {
  formatManifestSummary,
  hasMissingRoots,
  manifestPath,
  tryReadManifest,
  writeManifest,
} from '../../indexer/manifest-store.js';
import { isEmptyManifest, type SuiteManifest } from '../../schemas/manifest.js';

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

  // `--root` given wins and replaces; absent, the previous scan's roots are
  // reused. In a monorepo those directories hold every credential getter and
  // repository, so forgetting the flag does not fail — it writes a manifest
  // missing them, and the planner then invents the names it cannot find.
  const previous = tryReadManifest(projectRoot);
  const roots = opts.root ?? previous?.roots ?? [];

  const manifest = scanManifest({
    projectRoot,
    suiteDir: config.suiteDir,
    ...(roots.length > 0 ? { extraRoots: roots } : {}),
    logger,
  });

  if (opts.json) {
    console.log(JSON.stringify(manifest, null, 2));
  } else {
    console.log(formatManifestSummary(manifest));
  }

  writeManifest(projectRoot, manifest);

  const lost = shrinkage(previous, manifest);

  if (!opts.json) {
    if (roots.length > 0) {
      console.log(
        `\nScanned ${config.suiteDir} plus ${roots.join(', ')}` +
          (opts.root === undefined ? ' (remembered from the last scan)' : ''),
      );
    }
    console.log(`\nWritten to ${manifestPath(projectRoot)}`);
    if (hasMissingRoots(manifest)) {
      // An empty manifest here means the scan looked in the wrong place, so the
      // greenfield message below would be actively misleading.
      console.log(
        '\nNo files were scanned. Fix the paths marked ! above — `suiteDir` in\n' +
          'flint.config.ts and any --root values are relative to the project root.',
      );
    } else if (isEmptyManifest(manifest)) {
      // Not a warning: an empty manifest is the correct answer for a project
      // that has not generated anything yet, and the first feature will build
      // the login flow along with everything else.
      console.log(
        '\nNothing to reuse yet — this is a new suite. The first generated\n' +
          'feature will create the flows, data and helpers it needs.',
      );
    }

    if (lost.length > 0) {
      console.log(
        `\nThis scan found less than the last one: ${lost.join(', ')}.\n` +
          'Either the suite really shrank, or this scan looked in fewer places —\n' +
          'check `suiteDir` and `--root`. Nothing downstream will complain: the\n' +
          'planner simply stops finding what it needs and starts guessing.',
      );
    }
  }
}

/**
 * What this scan found less of than the last one.
 *
 * The failure this guards against is silent by construction. A scan that misses
 * a monorepo package still succeeds, still writes a manifest, and still prints a
 * cheerful summary — the counts are just smaller, and nobody remembers what they
 * were yesterday. Downstream, an empty `credentials` list means the prompt has
 * no credential section at all, so the model invents getter names that look
 * exactly like real ones. Comparing against the manifest already on disk is the
 * only cheap place to notice.
 */
export function shrinkage(before: SuiteManifest | undefined, after: SuiteManifest): string[] {
  if (before === undefined) return [];
  const counts = (m: SuiteManifest): Array<[string, number]> => [
    ['flows', m.flows.length],
    ['credentials', m.credentials.length],
    ['repositories', m.repositories.length],
    ['data files', m.data.length],
    ['helpers', m.helpers.length],
  ];
  const previous = new Map(counts(before));
  return counts(after)
    .filter(([name, now]) => now < (previous.get(name) ?? 0))
    .map(([name, now]) => `${name} ${previous.get(name)} -> ${now}`);
}
