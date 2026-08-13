import { relative } from 'node:path';

/**
 * Small helpers for making CLI error hints runnable rather than merely correct.
 *
 * A hint that states the grammar (`Usage: flint plan <feature>`) tells someone
 * what they did wrong. A hint that shows the command they should have typed,
 * with the flags they already typed, lets them fix it without reconstructing it
 * by hand. The second is worth the few lines.
 */

/**
 * Render `--dir <path>` for a hint, or nothing when the default is in use.
 *
 * Echoing the caller's own `--dir` matters because these commands are usually
 * run from a different directory than the project they target; a suggested
 * command without it would be wrong in exactly the situation where the hint is
 * most needed.
 */
export function dirSuffix(dir: string | undefined): string {
  if (dir === undefined || dir === '' || dir === '.') return '';
  return ` --dir ${dir}`;
}

/**
 * A path the operator can paste into their shell.
 *
 * Relative when that is shorter and stays inside the current directory,
 * absolute otherwise. The failure this avoids: printing a path relative to the
 * *project* root while the shell sits in the Flint checkout, which produces a
 * line that looks copy-pasteable and is not.
 */
export function displayPath(absolutePath: string, cwd: string = process.cwd()): string {
  const rel = relative(cwd, absolutePath);
  if (rel === '') return absolutePath;
  return rel.startsWith('..') ? absolutePath : rel;
}
