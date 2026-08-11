import { resolve } from 'node:path';
import type { Command } from 'commander';
import { loadConfig } from '../../config/load.js';
import { createLogger } from '../../shared/logger.js';
import { scanSuite } from '../../indexer/scan.js';
import { formatIndex, indexPath, writeIndex } from '../../indexer/store.js';

/**
 * `flint index` — build the Suite Index from the existing `e2e/` suite.
 *
 * Purely static: it reads files, never runs them and never touches a browser.
 * Safe against any suite, including one that does not compile.
 */
export function registerIndex(program: Command): void {
  program
    .command('index')
    .description('Build the Suite Index from the existing e2e/ suite')
    .option('-d, --dir <dir>', 'project directory', '.')
    .option('--json', 'print the index as JSON instead of a summary', false)
    .option('-v, --verbose', 'verbose logging', false)
    .action(async (opts: IndexOptions) => {
      await runIndex(opts);
    });
}

interface IndexOptions {
  dir: string;
  json: boolean;
  verbose: boolean;
}

async function runIndex(opts: IndexOptions): Promise<void> {
  const projectRoot = resolve(process.cwd(), opts.dir);
  const logger = createLogger({ verbose: opts.verbose });
  const { config } = await loadConfig(projectRoot);

  const result = scanSuite({ projectRoot, suiteDir: config.suiteDir, logger });

  if (opts.json) {
    console.log(JSON.stringify(result.index, null, 2));
  } else {
    console.log('');
    console.log(formatIndex(result));
  }

  const path = indexPath(projectRoot);
  writeIndex(path, result.index);

  if (!opts.json) {
    console.log(`\nSuite Index written to ${path}`);
    if (result.suiteMissing) {
      // An empty index is valid and useful — the first generate run creates the
      // suite — but silently indexing a directory that isn't there is how a
      // typo'd suiteDir goes unnoticed until Phase 4 emits into nowhere.
      console.log('');
      console.log(`NOTE: the suite directory does not exist yet: ${config.suiteDir}`);
      console.log(
        '      The index is empty. Check `suiteDir` in flint.config.ts if that is wrong.',
      );
    }
  }
}
