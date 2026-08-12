import { readdirSync, readFileSync, statSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Read the TypeScript files already in a suite, keyed by suite-relative posix
 * path.
 *
 * The compile gate needs these: a generated spec importing an existing helper
 * must be typechecked against the real helper, not against nothing. Only `.ts`
 * files are read, `node_modules` is skipped, and paths are normalized to posix
 * so a Windows suite produces the same keys as a Linux one.
 */

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'test-results',
  'playwright-report',
  // The compile gate's own scratch copy, which lives inside the suite so that
  // `node_modules` resolves. Reading it back would nest a copy in a copy.
  '.flint-gate',
]);

export function discoverSuiteFiles(suiteRoot: string): Map<string, string> {
  const files = new Map<string, string>();
  if (!existsSync(suiteRoot)) return files;
  walk(suiteRoot, suiteRoot, files);
  // Sorted so the gate's scratch copy is written in a stable order.
  return new Map([...files.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function walk(root: string, dir: string, out: Map<string, string>): void {
  for (const entry of readdirSync(dir)) {
    if (IGNORED_DIRS.has(entry)) continue;
    const absolute = join(dir, entry);
    let stats;
    try {
      stats = statSync(absolute);
    } catch {
      continue; // a symlink to nowhere must not fail a generation
    }
    if (stats.isDirectory()) {
      walk(root, absolute, out);
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    out.set(relative(root, absolute).split(sep).join('/'), readFileSync(absolute, 'utf8'));
  }
}
