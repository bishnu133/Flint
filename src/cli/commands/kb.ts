import { resolve } from 'node:path';
import type { Command } from 'commander';
import { loadConfig } from '../../config/load.js';
import { createLogger } from '../../shared/logger.js';
import { scanManifest } from '../../indexer/manifest-scan.js';
import { tryReadManifest } from '../../indexer/manifest-store.js';
import { readAllFeatureSpecs, readFeatureSpec } from '../../planner/feature-spec.js';
import { readAppKnowledge } from '../../planner/kb-app.js';
import { checkKbGaps, checkKnowledgeIntegrity, type GapReport } from '../../planner/kb-gaps.js';
import { formatGapReport, gapSummary } from '../../planner/kb-report.js';
import { modelPath, readModel } from '../../explorer/screen-model-store.js';
import { EMPTY_KNOWLEDGE } from '../../schemas/kb-app.js';

/**
 * `flint kb` — what the knowledge base cannot yet answer.
 *
 * Static and free: it reads feature specs, `kb/app/`, the manifest and the
 * Screen Model, and resolves every declared data need against them. No browser,
 * no model call. Run it before `flint ci` and you learn which features are
 * groundable before paying to plan them.
 */
export function registerKb(program: Command): void {
  program
    .command('kb')
    .description('Check declared data needs against the knowledge base and the suite')
    .option('-d, --dir <dir>', 'project directory', '.')
    .option('--feature <id...>', 'only these features (default: every spec)')
    .option('--root <path...>', 'extra directories to scan when rebuilding the manifest')
    .option('--json', 'print a machine-readable summary', false)
    .option('--strict', 'exit non-zero when any gap is found', false)
    .option('-v, --verbose', 'verbose logging', false)
    .action(async (opts: KbOptions) => {
      await runKb(opts);
    });
}

interface KbOptions {
  dir: string;
  feature?: string[];
  root?: string[];
  json: boolean;
  strict: boolean;
  verbose: boolean;
}

async function runKb(opts: KbOptions): Promise<void> {
  const projectRoot = resolve(process.cwd(), opts.dir);
  const logger = createLogger({ verbose: opts.verbose });
  const { config } = await loadConfig(projectRoot);

  const specs =
    opts.feature === undefined
      ? readAllFeatureSpecs(projectRoot, config.kbDir)
      : opts.feature.map((id) => readFeatureSpec(projectRoot, config.kbDir, id));

  const knowledge = (() => {
    try {
      return readAppKnowledge(projectRoot, config.kbDir);
    } catch {
      // Unreadable knowledge is a report full of gaps, never a failed command —
      // the whole point is to run when the KB is incomplete.
      return EMPTY_KNOWLEDGE;
    }
  })();

  // Prefer the stored manifest so this stays fast, but rebuild rather than
  // report phantom broken references against a manifest that predates the
  // suite. A stale manifest here would blame the KB for the scan being old.
  const manifest =
    tryReadManifest(projectRoot) ??
    scanManifest({
      projectRoot,
      suiteDir: config.suiteDir,
      ...(opts.root !== undefined ? { extraRoots: opts.root } : {}),
      logger,
    });

  const knownPages = readKnownPages(projectRoot);

  // Checked first, and independent of any spec: a KB reference to a method
  // somebody deleted is already broken, whether or not today's feature needs it.
  const integrity = checkKnowledgeIntegrity(knowledge, manifest, config.kbDir);

  const reports: GapReport[] = specs.map((spec) =>
    checkKbGaps({
      spec,
      knowledge,
      manifest,
      kbDir: config.kbDir,
      ...(knownPages !== undefined ? { knownPages } : {}),
    }),
  );

  const all: GapReport[] =
    integrity.length === 0
      ? reports
      : [{ featureId: 'knowledge base', gaps: integrity, grounded: [] }, ...reports];

  if (opts.json) {
    console.log(JSON.stringify(gapSummary(all, knowledge), null, 2));
  } else {
    console.log(formatGapReport(all, knowledge));
  }

  if (opts.strict && all.some((r) => r.gaps.length > 0)) process.exitCode = 1;
}

/** `urlPattern`s from the Screen Model, when one has been built. */
function readKnownPages(projectRoot: string): string[] | undefined {
  try {
    return readModel(modelPath(projectRoot)).pages.map((p) => p.urlPattern);
  } catch {
    // No Screen Model yet is normal before the first `flint explore`, and
    // reporting every `pages:` hint as unknown would be noise, not a finding.
    return undefined;
  }
}
