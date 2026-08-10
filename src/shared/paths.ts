import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the TestGen package root (the directory containing our own
 * package.json). Works both when running from source (tsx/vitest) and from the
 * compiled `dist/` output, so bundled `templates/` and prompt files are found in
 * either mode.
 */
export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  // Walk up until we find the package.json whose name is "testgen".
  for (let i = 0; i < 10; i += 1) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'Could not locate TestGen package root (no package.json found while walking up).',
  );
}

/** Absolute path to the `templates/` directory shipped with TestGen. */
export function templatesDir(): string {
  return join(packageRoot(), 'templates');
}

/** Absolute path to the versioned prompt templates directory. */
export function promptsDir(): string {
  return join(packageRoot(), 'src', 'generator', 'prompts');
}
