import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { classify, withMarker } from '../indexer/managed.js';
import type { EmittedFile } from '../generator/emitter.js';
import { silentLogger, type Logger } from '../shared/logger.js';

/**
 * Idempotent writer for a suite Flint does not own.
 *
 * Three cases, decided by the managed marker (Phase 2):
 *
 *   - **absent** — write it, stamped as managed.
 *   - **managed and unchanged by a human** — overwrite freely.
 *   - **hand-edited** — a human changed generated code. Overwriting would
 *     destroy their work, so the new version goes to a sibling `.flint.ts`
 *     file and the collision is reported. Silence here would be the worst
 *     possible failure mode: a tool that eats your edits gets uninstalled.
 *   - **hand-written** (no marker at all) — Flint never touches it. Same
 *     sibling treatment.
 *
 * A file whose content already matches byte-for-byte is reported `unchanged`
 * and not rewritten, so regenerating an untouched feature leaves the working
 * tree clean — which is what makes the determinism check observable in git.
 */

export type WriteOutcome = 'created' | 'updated' | 'unchanged' | 'diverted';

export interface WriteDecision {
  /** Path relative to the suite root, as the emitter produced it. */
  path: string;
  /** Where it will actually be written — differs from `path` when diverted. */
  targetPath: string;
  outcome: WriteOutcome;
  /** Present when diverted: why the original could not be overwritten. */
  reason?: string;
  /** The exact bytes that would be written, marker included. */
  contents: string;
}

export interface PlanWriteOptions {
  /** Absolute path of the suite root (`config.suiteDir` resolved). */
  suiteRoot: string;
  files: EmittedFile[];
  logger?: Logger;
}

/**
 * Decide what would happen to each file, without touching the disk.
 *
 * `flint generate --dry-run` renders exactly this, so the preview a human
 * approves is the same computation that later runs.
 */
export function planWrites(options: PlanWriteOptions): WriteDecision[] {
  return options.files.map((file) => decide(options.suiteRoot, file));
}

function decide(suiteRoot: string, file: EmittedFile): WriteDecision {
  const absolute = resolve(suiteRoot, file.path);
  const contents = withMarker(file.contents);

  if (!existsSync(absolute)) {
    return { path: file.path, targetPath: file.path, outcome: 'created', contents };
  }

  const existing = readFileSync(absolute, 'utf8');
  const status = classify(existing).status;

  if (status === 'managed') {
    return existing === contents
      ? { path: file.path, targetPath: file.path, outcome: 'unchanged', contents }
      : { path: file.path, targetPath: file.path, outcome: 'updated', contents };
  }

  const reason =
    status === 'hand-edited'
      ? 'the generated file has been edited by hand'
      : 'a hand-written file already owns this path';

  return {
    path: file.path,
    targetPath: siblingPath(file.path),
    outcome: 'diverted',
    reason,
    contents,
  };
}

/** `pages/login.page.ts` -> `pages/login.page.flint.ts`. */
export function siblingPath(path: string): string {
  return path.replace(/\.ts$/, '.flint.ts');
}

export interface ApplyResult {
  decisions: WriteDecision[];
  written: number;
  diverted: WriteDecision[];
}

/** Apply a set of decisions. Directories are created as needed. */
export function applyWrites(
  suiteRoot: string,
  decisions: WriteDecision[],
  logger: Logger = silentLogger(),
): ApplyResult {
  let written = 0;
  for (const decision of decisions) {
    if (decision.outcome === 'unchanged') continue;
    const absolute = resolve(suiteRoot, decision.targetPath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, decision.contents, 'utf8');
    written += 1;
    logger.debug({ path: decision.targetPath, outcome: decision.outcome }, 'write');
  }

  const diverted = decisions.filter((d) => d.outcome === 'diverted');
  for (const decision of diverted) {
    logger.warn(
      { path: decision.path, wroteTo: decision.targetPath, reason: decision.reason },
      'generate: kept your version and wrote ours beside it',
    );
  }

  return { decisions, written, diverted };
}

/** A human-readable preview, used by `--dry-run` and after a real write. */
export function formatWritePlan(decisions: WriteDecision[], suiteDir: string): string {
  if (decisions.length === 0) return 'Nothing to write.';
  const label: Record<WriteOutcome, string> = {
    created: 'create ',
    updated: 'update ',
    unchanged: 'same   ',
    diverted: 'DIVERT ',
  };
  const lines = decisions.map((decision) => {
    const path = join(suiteDir, decision.targetPath);
    return decision.outcome === 'diverted'
      ? `  ${label[decision.outcome]} ${path}\n           (${decision.reason}; your ${join(suiteDir, decision.path)} is untouched)`
      : `  ${label[decision.outcome]} ${path}`;
  });
  return lines.join('\n');
}
