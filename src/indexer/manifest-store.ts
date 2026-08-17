import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SuiteManifestSchema, type SuiteManifest } from '../schemas/manifest.js';
import { ConfigError } from '../shared/errors.js';

/** Manifest persistence, beside the Screen Model and Suite Index under `.flint/`. */

export const MANIFEST_PATH = join('.flint', 'manifest.json');

export function manifestPath(projectRoot: string): string {
  return join(projectRoot, MANIFEST_PATH);
}

export function writeManifest(projectRoot: string, manifest: SuiteManifest): void {
  const path = manifestPath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

export function readManifest(projectRoot: string): SuiteManifest {
  const path = manifestPath(projectRoot);
  if (!existsSync(path)) {
    throw new ConfigError(`No suite manifest at ${path}.`, {
      hint: 'Run `flint manifest` to build one.',
    });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ConfigError(`Suite manifest is not valid JSON: ${path}.`, {
      cause: err,
      hint: 'Delete it and re-run `flint manifest` — it is derived, so nothing is lost.',
    });
  }
  return SuiteManifestSchema.parse(raw);
}

export function tryReadManifest(projectRoot: string): SuiteManifest | undefined {
  try {
    return existsSync(manifestPath(projectRoot)) ? readManifest(projectRoot) : undefined;
  } catch {
    // Derived data: an unreadable manifest is a rescan, never a failed run.
    return undefined;
  }
}

/**
 * Human-readable summary for the CLI.
 *
 * Deliberately short. The manifest itself is machine input — nobody should have
 * to read the JSON — so this exists to answer one question at a glance: does
 * the scan look like the suite I have?
 */
export function formatManifestSummary(manifest: SuiteManifest): string {
  const lines = [
    `Flows           ${manifest.flows.length}`,
    `Data exports    ${manifest.data.length}`,
    `Helpers         ${manifest.helpers.length}`,
    `Credentials     ${manifest.credentials.length}`,
    `Repositories    ${manifest.repositories.length}`,
  ];

  const byKind = new Map<string, number>();
  for (const flow of manifest.flows) byKind.set(flow.kind, (byKind.get(flow.kind) ?? 0) + 1);
  if (byKind.size > 0) {
    lines.push('', 'Flows by kind');
    for (const [kind, count] of [...byKind].sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`  ${kind.padEnd(12)}${count}`);
    }
  }

  const unused = manifest.flows.filter((f) => f.usedBy.length === 0);
  if (unused.length > 0) {
    lines.push(
      '',
      `${unused.length} flow(s) not imported by any test:`,
      ...unused.slice(0, 10).map((f) => `  ${f.id}`),
    );
    if (unused.length > 10) lines.push(`  … and ${unused.length - 10} more`);
  }

  if (manifest.warnings.length > 0) {
    lines.push('', `${manifest.warnings.length} file(s) could not be parsed:`);
    for (const w of manifest.warnings.slice(0, 5)) lines.push(`  ${w.file}: ${w.message}`);
  }
  return lines.join('\n');
}
