/**
 * Refusing to commit somebody's `node_modules`.
 *
 * `flint pr` stages by path — `<suiteDir>/` and `.flint/` — which is the right
 * scope, and it relies on git to decide what inside those paths is worth
 * committing. Git decides that from `.gitignore`, and a project scaffolded by
 * `flint init` does not have one. So in a fresh demo project the suite
 * directory contains `node_modules/` (the generated suite has its own
 * `@playwright/test` dependency, installed there on purpose), and `git add --
 * e2e` sweeps every one of those files into the pull request.
 *
 * Seven hundred vendored files in a generated PR is not a cosmetic problem: it
 * is unreviewable, and the reviewer's first impression of the tool is that it
 * does not know what it is doing.
 *
 * Flint refuses rather than quietly excluding them. Excluding would leave the
 * project's own `git status` permanently full of untracked build output — the
 * missing `.gitignore` is the actual defect, and the operator has to fix it for
 * their own sake, not just for Flint's commit. So: name the paths, print the
 * file to write, stop.
 */

/**
 * Path segments that must never reach a commit. Directories, plus one file that
 * macOS scatters everywhere and that nobody has ever wanted in a diff.
 */
export const VENDORED_SEGMENTS = [
  'node_modules',
  'test-results',
  'playwright-report',
  'blob-report',
  '.DS_Store',
] as const;

/** Which of these files sit under a vendored path. Order is preserved. */
export function vendoredPaths(files: readonly string[]): string[] {
  return files.filter((file) =>
    file.split('/').some((segment) => (VENDORED_SEGMENTS as readonly string[]).includes(segment)),
  );
}

/** The distinct segments responsible, for a message that names causes not files. */
export function vendoredReasons(files: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const file of files) {
    for (const segment of file.split('/')) {
      if ((VENDORED_SEGMENTS as readonly string[]).includes(segment)) seen.add(segment);
    }
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/**
 * The `.gitignore` a Playwright suite needs, ready to paste.
 *
 * Written for the project root rather than the suite directory, because that is
 * where the operator will run `git status` and where a single file covers both
 * the suite and Flint's own scratch output.
 */
export function gitignoreSuggestion(suiteDir: string): string {
  return [
    '# Dependencies of the generated suite',
    `${suiteDir}/node_modules/`,
    '',
    '# Playwright run output',
    `${suiteDir}/test-results/`,
    `${suiteDir}/playwright-report/`,
    `${suiteDir}/blob-report/`,
    '',
    '# Local noise',
    '.DS_Store',
    '.env',
  ].join('\n');
}
