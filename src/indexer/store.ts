import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SuiteIndexSchema, type SuiteIndex } from '../schemas/suite-index.js';
import { ConfigError } from '../shared/errors.js';
import { formatZodError } from '../shared/zod-format.js';
import type { ScanResult } from './scan.js';

/**
 * Suite Index persistence.
 *
 * Mirrors the Screen Model store deliberately: same directory, same
 * write-canonical / read-validated shape, so the two artefacts behave
 * identically for anyone reading `.flint/`.
 */

export const SUITE_INDEX_FILE = join('.flint', 'suite-index.json');

export function indexPath(projectRoot: string): string {
  return join(projectRoot, SUITE_INDEX_FILE);
}

export function writeIndex(path: string, index: SuiteIndex): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
}

/** Read and validate an index. Throws a friendly error naming the bad key. */
export function readIndex(path: string): SuiteIndex {
  if (!existsSync(path)) {
    throw new ConfigError(`No Suite Index at ${path}.`, {
      hint: 'Run `flint index` first to build one.',
    });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ConfigError(`Suite Index is not valid JSON: ${path}.`, {
      cause: err,
      hint: 'Delete it and re-run `flint index`.',
    });
  }
  const parsed = SuiteIndexSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(
      `Suite Index failed validation (${path}):\n${formatZodError(parsed.error)}`,
      {
        hint: 'Delete it and re-run `flint index`.',
      },
    );
  }
  return parsed.data;
}

export function tryReadIndex(path: string): SuiteIndex | undefined {
  return existsSync(path) ? readIndex(path) : undefined;
}

/**
 * Human-readable summary.
 *
 * Leads with the counts, then the two things a human actually needs to act on:
 * files they hand-edited (which Phase 4 will refuse to overwrite) and files it
 * could not parse.
 */
export function formatIndex(result: ScanResult): string {
  const { index } = result;
  const testCount = index.specs.reduce((n, s) => n + s.testTitles.length, 0);
  const lines = [
    `Suite:            ${index.suiteDir}`,
    `Page objects:     ${index.pageObjects.length}`,
    `Spec files:       ${index.specs.length} (${testCount} test${testCount === 1 ? '' : 's'})`,
    `Fixtures:         ${index.fixtures.length}`,
    `Data factories:   ${index.dataFactories.length}`,
    `Features covered: ${Object.keys(index.coverageMap).length}`,
    `Flint-managed:    ${index.managedFiles.length}`,
  ];

  if (index.handEditedFiles.length > 0) {
    lines.push('', 'Hand-edited generated files (Flint will not overwrite these):');
    for (const file of index.handEditedFiles) lines.push(`  ~ ${file}`);
  }
  if (result.warnings.length > 0) {
    lines.push('', `Files skipped (${result.warnings.length}):`);
    for (const warning of result.warnings) lines.push(`  ! ${warning.file} — ${warning.message}`);
  }
  return lines.join('\n');
}
