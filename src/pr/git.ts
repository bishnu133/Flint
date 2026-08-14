import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { FlintError } from '../shared/errors.js';

/**
 * The narrowest git wrapper that can open a pull request.
 *
 * Deliberately small. Flint is a test generator, not a version-control tool,
 * and every command here is one that runs against somebody's real repository —
 * so the surface is the four verbs the PR flow needs and nothing else. There is
 * no `reset`, no `checkout --force`, no `clean`: nothing here can destroy work.
 *
 * Staging is **path-scoped**, never `git add -A`. A generator that sweeps the
 * whole working tree into its commit will eventually publish somebody's
 * half-finished refactor or their `.env`, and they will find out from the PR.
 */

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export function git(cwd: string, args: string[]): GitResult {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  };
}

export function isRepo(cwd: string): boolean {
  return git(cwd, ['rev-parse', '--is-inside-work-tree']).stdout === 'true';
}

export function currentBranch(cwd: string): string | undefined {
  const result = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return result.ok && result.stdout !== '' ? result.stdout : undefined;
}

/** Files with changes under the given paths. Empty means nothing to propose. */
export function changedUnder(cwd: string, paths: string[]): string[] {
  // `-uall` matters: without it git collapses an untracked directory to
  // `e2e/`, and a caller listing "files to commit" would show one line for a
  // hundred new specs.
  const result = git(cwd, ['status', '--porcelain', '-uall', '--', ...paths]);
  if (!result.ok || result.stdout === '') return [];
  return result.stdout
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter((line) => line !== '')
    .sort();
}

/**
 * Changes **outside** the paths Flint owns.
 *
 * Reported, not committed. Somebody mid-refactor should not discover their
 * work-in-progress in a generated pull request, and the honest handling is to
 * leave it alone and say it is there.
 */
export function changedOutside(cwd: string, ownedPaths: string[]): string[] {
  const all = git(cwd, ['status', '--porcelain', '-uall']);
  if (!all.ok || all.stdout === '') return [];
  const owned = new Set(changedUnder(cwd, ownedPaths));
  return all.stdout
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter((line) => line !== '' && !owned.has(line))
    .sort();
}

/** Create and switch to a branch. Fails loudly if the name is taken. */
export function createBranch(cwd: string, branch: string): void {
  const result = git(cwd, ['checkout', '-b', branch]);
  if (!result.ok) {
    throw new FlintError(`Could not create branch "${branch}".`, {
      code: 'PR',
      hint: `git said: ${result.stderr}. Pick another name with --branch, or delete the existing one.`,
    });
  }
}

export function branchExists(cwd: string, branch: string): boolean {
  return git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).ok;
}

/** Stage only the given paths, then commit. Returns the new commit's sha. */
export function commitPaths(cwd: string, paths: string[], message: string): string {
  // A path that does not exist yet is not an error — a project with no `.flint`
  // directory is normal. Staging it anyway makes git fail the whole commit with
  // "pathspec did not match", which reads like a Flint bug and is not one.
  const present = paths.filter((path) => existsSync(join(cwd, path)));
  if (present.length === 0) {
    throw new FlintError('Nothing to commit — none of the generated paths exist.', {
      code: 'PR',
      hint: `Looked for: ${paths.join(', ')}. Run \`flint ci\` first.`,
    });
  }

  const add = git(cwd, ['add', '--', ...present]);
  if (!add.ok) {
    throw new FlintError('Could not stage the generated files.', {
      code: 'PR',
      hint: `git said: ${add.stderr}`,
    });
  }
  const commit = git(cwd, ['commit', '-m', message]);
  if (!commit.ok) {
    throw new FlintError('Could not create the commit.', {
      code: 'PR',
      hint: `git said: ${commit.stderr || commit.stdout}`,
    });
  }
  return git(cwd, ['rev-parse', 'HEAD']).stdout;
}

export function push(cwd: string, remote: string, branch: string): GitResult {
  return git(cwd, ['push', '-u', remote, branch]);
}

export function remoteUrl(cwd: string, remote: string): string | undefined {
  const result = git(cwd, ['remote', 'get-url', remote]);
  return result.ok && result.stdout !== '' ? result.stdout : undefined;
}

/** The repository's default branch, per the remote's HEAD. */
export function defaultBranch(cwd: string, remote: string): string | undefined {
  const result = git(cwd, ['symbolic-ref', '--quiet', `refs/remotes/${remote}/HEAD`]);
  if (!result.ok) return undefined;
  const parts = result.stdout.split('/');
  return parts[parts.length - 1];
}
