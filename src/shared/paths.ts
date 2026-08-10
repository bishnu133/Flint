import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the Flint package root (the directory containing our own
 * package.json, verified by `name: "flint"`). Works both when running from
 * source (tsx/vitest) and from the compiled `dist/` output, so bundled
 * `templates/` and prompt files are found in either mode. An intermediate
 * package.json (e.g. one emitted into dist/ by a publish workflow) is skipped
 * because its name won't match.
 */
export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i += 1) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate) && isFlintPackage(candidate)) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'Could not locate Flint package root (no package.json with name "flint" found while walking up).',
  );
}

function isFlintPackage(packageJsonPath: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { name?: unknown };
    return pkg.name === 'flint';
  } catch {
    return false; // unreadable/invalid package.json — keep walking
  }
}

/** Absolute path to the `templates/` directory shipped with Flint. */
export function templatesDir(): string {
  return join(packageRoot(), 'templates');
}

/** Absolute path to the versioned prompt templates directory. */
export function promptsDir(): string {
  return join(packageRoot(), 'src', 'generator', 'prompts');
}
