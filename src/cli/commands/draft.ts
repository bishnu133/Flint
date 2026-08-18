import { existsSync, readFileSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import type { Command } from 'commander';
import { loadConfig } from '../../config/load.js';
import { createLogger } from '../../shared/logger.js';
import { ConfigError } from '../../shared/errors.js';
import { AnthropicProvider } from '../../llm/index.js';
import { scanManifest } from '../../indexer/manifest-scan.js';
import { tryReadManifest } from '../../indexer/manifest-store.js';
import { readAppKnowledge } from '../../planner/kb-app.js';
import { documentWarning, draftKnowledgeBase } from '../../planner/draft.js';
import { formatDraftSummary, renderDraft, writeDraft } from '../../planner/draft-writer.js';
import { modelPath, readModel } from '../../explorer/screen-model-store.js';
import { EMPTY_KNOWLEDGE } from '../../schemas/kb-app.js';
import type { ScreenModel } from '../../schemas/screen-model.js';

/**
 * `flint draft <document>` — turn a requirement document into a draft
 * knowledge base (Bubblegum B2.5).
 *
 * Drop a JIRA export, a user story, a spec — anything textual — and Flint
 * writes the feature specs and entity files it implies, with setup paths
 * matched against the suite it already scanned.
 *
 * The output is a draft, marked as one. It is meant to be read and corrected,
 * because a requirement document is a conversation: it carries comments,
 * superseded wording, and requirements for systems this suite does not drive.
 * Five minutes of review is a very different thing from writing the files by
 * hand, which is what this stage exists to stop.
 */
export function registerDraft(program: Command): void {
  program
    .command('draft <document>')
    .description('Draft feature specs and knowledge base from a requirement document')
    .option('-d, --dir <dir>', 'project directory', '.')
    .option('--root <path...>', 'extra directories to scan when rebuilding the manifest')
    .option('--dry-run', 'print what would be written without writing it', false)
    .option('--json', 'print the raw draft as JSON', false)
    .option('-v, --verbose', 'verbose logging', false)
    .action(async (document: string, opts: DraftOptions) => {
      await runDraft(document, opts);
    });
}

interface DraftOptions {
  dir: string;
  root?: string[];
  dryRun: boolean;
  json: boolean;
  verbose: boolean;
}

async function runDraft(documentPath: string, opts: DraftOptions): Promise<void> {
  const projectRoot = resolve(process.cwd(), opts.dir);
  const logger = createLogger({ verbose: opts.verbose });
  const { config } = await loadConfig(projectRoot);

  // Resolved against the working directory, not the project — the document is
  // something the operator dropped somewhere convenient, and making them put it
  // inside the project first would be a pointless step.
  const absolute = resolve(process.cwd(), documentPath);
  if (!existsSync(absolute)) {
    throw new ConfigError(`No document at ${absolute}.`, {
      hint: 'Pass a path to the requirement file, e.g. `flint draft ./HPBPPH-17169.md`.',
    });
  }
  const document = readFileSync(absolute, 'utf8');
  if (document.trim() === '') {
    throw new ConfigError(`${absolute} is empty.`, {
      hint: 'Export the card as text or markdown — a PDF will not read as text here.',
    });
  }

  const oversized = documentWarning(document, basename(absolute));
  if (oversized !== undefined) console.log(`${oversized}\n`);

  const manifest =
    tryReadManifest(projectRoot) ??
    scanManifest({
      projectRoot,
      suiteDir: config.suiteDir,
      ...(opts.root !== undefined ? { extraRoots: opts.root } : {}),
      logger,
    });

  const existing = (() => {
    try {
      return readAppKnowledge(projectRoot, config.kbDir);
    } catch {
      return EMPTY_KNOWLEDGE;
    }
  })();

  const screenModel = readScreenModel(projectRoot);
  if (screenModel === undefined) {
    // Worth saying out loud: without it the model cannot tell a screen this
    // suite drives from one belonging to another system, which is the judgement
    // the out-of-scope list depends on.
    console.log('No Screen Model yet — run `flint explore` first for a better scope split.\n');
  }

  const provider = new AnthropicProvider({ logger, logPrompts: config.debug.logPrompts });
  const result = await draftKnowledgeBase({
    document,
    manifest,
    provider,
    modelId: config.models.planner,
    ...(screenModel !== undefined ? { model: screenModel } : {}),
    existing,
    logger,
  });

  if (opts.json) {
    console.log(JSON.stringify(result.draft, null, 2));
    return;
  }

  const files = renderDraft({
    draft: result.draft,
    resolutions: result.resolutions,
    manifest,
    kbDir: config.kbDir,
    source: basename(absolute),
    projectRoot,
  });

  if (!opts.dryRun) writeDraft(projectRoot, files);

  console.log(formatDraftSummary(result.draft, result.resolutions, files, result.needs));
  if (opts.dryRun) {
    console.log(
      `\n(--dry-run: nothing written. Drop it to write into ${relative(process.cwd(), projectRoot) || '.'}.)`,
    );
  }
}

function readScreenModel(projectRoot: string): ScreenModel | undefined {
  try {
    return readModel(modelPath(projectRoot));
  } catch {
    return undefined;
  }
}
