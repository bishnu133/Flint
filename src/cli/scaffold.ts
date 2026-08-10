import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';

/**
 * Project scaffolder for `flint init`.
 *
 * Copies the `templates/init/` tree into a target project, substituting
 * `{{placeholder}}` values in text files. Designed to NEVER clobber: it reports
 * conflicts so the command can prompt before overwriting (master plan Phase 0
 * scenario: re-running init must prompt, never overwrite).
 */

export interface ScaffoldFile {
  /** Path relative to the target project root. */
  rel: string;
  /** Absolute path of the source template file. */
  source: string;
}

/** Recursively enumerate the files to be scaffolded from a template root. */
export function planScaffold(templateRoot: string): ScaffoldFile[] {
  const files: ScaffoldFile[] = [];
  walk(templateRoot, templateRoot, files);
  // Stable ordering for deterministic output.
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return files;
}

function walk(root: string, dir: string, out: ScaffoldFile[]): void {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      walk(root, abs, out);
    } else {
      out.push({ rel: relative(root, abs), source: abs });
    }
  }
}

/** Return the subset of planned files that already exist in the target dir. */
export function detectConflicts(targetDir: string, plan: ScaffoldFile[]): string[] {
  return plan.filter((f) => existsSync(join(targetDir, f.rel))).map((f) => f.rel);
}

export interface ApplyResult {
  written: string[];
  skipped: string[];
}

/**
 * Write the scaffold to disk.
 *
 * Existing files are overwritten only when `overwrite` is true; otherwise they
 * are skipped (never clobbered) and reported in `skipped`.
 */
export function applyScaffold(
  targetDir: string,
  plan: ScaffoldFile[],
  vars: Record<string, string>,
  options: { overwrite: boolean },
): ApplyResult {
  const written: string[] = [];
  const skipped: string[] = [];
  for (const file of plan) {
    const dest = join(targetDir, file.rel);
    if (existsSync(dest) && !options.overwrite) {
      skipped.push(file.rel);
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    const content = substitute(readFileSync(file.source, 'utf8'), vars);
    writeFileSync(dest, content, 'utf8');
    written.push(file.rel);
  }
  return { written, skipped };
}

/** Replace `{{key}}` for every provided key. Unknown placeholders are left intact. */
export function substitute(content: string, vars: Record<string, string>): string {
  let result = content;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}
