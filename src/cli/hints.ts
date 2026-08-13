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
