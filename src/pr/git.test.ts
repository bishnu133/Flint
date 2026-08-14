import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  branchExists,
  changedOutside,
  changedUnder,
  commitPaths,
  createBranch,
  currentBranch,
  isRepo,
} from './git.js';

/**
 * Against a real repository, because the property that matters is one a mock
 * cannot check: **Flint stages only what it owns.** A generator that sweeps the
 * working tree into its commit will eventually publish somebody's `.env`.
 */

let repo: string;

function run(args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
}

function write(path: string, contents = 'x'): void {
  const absolute = join(repo, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents, 'utf8');
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'flint-git-'));
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Test']);
  write('README.md', 'seed');
  run(['add', '-A']);
  run(['commit', '-qm', 'seed']);
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('repository basics', () => {
  it('recognises a repository, and a directory that is not one', () => {
    expect(isRepo(repo)).toBe(true);
    const bare = mkdtempSync(join(tmpdir(), 'flint-nogit-'));
    try {
      expect(isRepo(bare)).toBe(false);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('reports the current branch', () => {
    expect(currentBranch(repo)).toBe('main');
  });
});

describe('changedUnder / changedOutside', () => {
  it('finds changes under the owned paths', () => {
    write('e2e/tests/login.spec.ts');
    write('.flint/plans/login.plan.json');
    expect(changedUnder(repo, ['e2e', '.flint'])).toEqual([
      '.flint/plans/login.plan.json',
      'e2e/tests/login.spec.ts',
    ]);
  });

  it('separates unrelated changes from owned ones', () => {
    write('e2e/tests/login.spec.ts');
    write('src/app.ts', 'half-finished refactor');
    write('.env', 'SECRET=hunter2');
    expect(changedUnder(repo, ['e2e', '.flint'])).toEqual(['e2e/tests/login.spec.ts']);
    expect(changedOutside(repo, ['e2e', '.flint'])).toEqual(['.env', 'src/app.ts']);
  });

  it('reports nothing when nothing changed', () => {
    expect(changedUnder(repo, ['e2e'])).toEqual([]);
    expect(changedOutside(repo, ['e2e'])).toEqual([]);
  });
});

describe('branch + commit', () => {
  it('creates a branch and knows when one exists', () => {
    expect(branchExists(repo, 'flint/x')).toBe(false);
    createBranch(repo, 'flint/x');
    expect(currentBranch(repo)).toBe('flint/x');
    expect(branchExists(repo, 'flint/x')).toBe(true);
  });

  it('refuses a branch name already in use, naming the fix', () => {
    createBranch(repo, 'flint/x');
    run(['checkout', '-q', 'main']);
    expect(() => createBranch(repo, 'flint/x')).toThrow(/already exists|Could not create branch/);
  });

  it('commits ONLY the owned paths, leaving unrelated work uncommitted', () => {
    // The load-bearing test. `git add -A` would sweep .env into the commit.
    write('e2e/tests/login.spec.ts');
    write('.env', 'SECRET=hunter2');
    createBranch(repo, 'flint/x');
    commitPaths(repo, ['e2e', '.flint'], 'test: generated');

    const committed = execFileSync('git', ['show', '--name-only', '--format=', 'HEAD'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim();
    expect(committed).toBe('e2e/tests/login.spec.ts');
    expect(changedOutside(repo, ['e2e', '.flint'])).toEqual(['.env']);
  });

  it('returns the new commit sha', () => {
    write('e2e/a.ts');
    createBranch(repo, 'flint/x');
    expect(commitPaths(repo, ['e2e'], 'test: generated')).toMatch(/^[0-9a-f]{40}$/);
  });

  it('throws with git’s own words when there is nothing new to commit', () => {
    write('e2e/a.ts');
    createBranch(repo, 'flint/x');
    commitPaths(repo, ['e2e'], 'test: generated');
    expect(() => commitPaths(repo, ['e2e'], 'test: again')).toThrow(/Could not create the commit/);
  });

  it('says so plainly when the generated paths do not exist at all', () => {
    // A project with no .flint directory is normal; `git add` would fail with
    // "pathspec did not match", which reads like a Flint bug and is not one.
    createBranch(repo, 'flint/x');
    expect(() => commitPaths(repo, ['e2e', '.flint'], 'test: nothing')).toThrow(
      /none of the generated paths exist/,
    );
  });
});
