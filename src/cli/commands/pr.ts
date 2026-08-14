import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import { loadConfig } from '../../config/load.js';
import { createLogger } from '../../shared/logger.js';
import { displayPath } from '../hints.js';
import { FlintError } from '../../shared/errors.js';
import { RunReportSchema, type RunReport } from '../../schemas/run-report.js';
import { readAllPlans } from '../../planner/store.js';
import { reportsDir } from '../../verifier/report.js';
import {
  branchExists,
  changedOutside,
  changedUnder,
  commitPaths,
  createBranch,
  currentBranch,
  defaultBranch,
  isRepo,
  push,
  remoteUrl,
} from '../../pr/git.js';
import { buildPrContent, commitMessage } from '../../pr/body.js';
import { createPullRequest, findToken, parseRemote } from '../../pr/github.js';
import { gitignoreSuggestion, vendoredPaths, vendoredReasons } from '../../pr/vendored.js';

/**
 * `flint pr` — propose the generated suite as a pull request.
 *
 * Two deliberate defaults, because this is the one command that touches
 * somebody else's repository:
 *
 * **It does not push.** By default it makes a branch and a commit locally and
 * prints the two commands to finish the job. `--push` is what lets it reach a
 * remote. A test generator that pushes as a side effect of generating tests is
 * a bad default, and the blast radius of getting it wrong is a branch on your
 * origin that you did not ask for.
 *
 * **It stages only what Flint owns** — the suite directory and `.flint/`, by
 * path. Never `git add -A`. Somebody mid-refactor should not discover their
 * work-in-progress in a generated pull request; unrelated changes are reported
 * and left alone.
 */
export function registerPr(program: Command): void {
  program
    .command('pr')
    .description('Commit the generated suite on a branch, and optionally open a pull request')
    .option('-d, --dir <dir>', 'project directory', '.')
    .option('-b, --branch <name>', 'branch name (default: flint/<timestamp>)')
    .option('--base <branch>', 'base branch for the PR (default: the remote default)')
    .option('--remote <name>', 'git remote', 'origin')
    .option('--push', 'push the branch and open the pull request', false)
    .option('--draft', 'open the pull request as a draft', false)
    .option('--title <title>', 'override the generated title')
    .option('--dry-run', 'print what would be committed and the PR body; change nothing', false)
    .option('-v, --verbose', 'verbose logging', false)
    .action(async (opts: PrOptions) => {
      await runPr(opts);
    });
}

interface PrOptions {
  dir: string;
  branch?: string;
  base?: string;
  remote: string;
  push: boolean;
  draft: boolean;
  title?: string;
  dryRun: boolean;
  verbose: boolean;
}

async function runPr(opts: PrOptions): Promise<void> {
  const projectRoot = resolve(process.cwd(), opts.dir);
  const logger = createLogger({ verbose: opts.verbose });
  const { config } = await loadConfig(projectRoot);

  if (!isRepo(projectRoot)) {
    throw new FlintError(`${projectRoot} is not a git repository.`, {
      code: 'PR',
      hint: 'Run `git init` there, or point --dir at the repository that holds the suite.',
    });
  }

  // Only ever these. Everything else in the tree is somebody else's business.
  const owned = [config.suiteDir, '.flint'];
  const changed = changedUnder(projectRoot, owned);
  if (changed.length === 0) {
    console.log('');
    console.log('Nothing to propose — no changes under', owned.join(' or '));
    console.log('Run `flint ci` first, or commit the changes you already have.');
    process.exitCode = 1;
    return;
  }

  // Before anything else: a project with no .gitignore has `node_modules`
  // sitting inside the suite directory, and staging by path would put every one
  // of those files in the pull request.
  const vendored = vendoredPaths(changed);
  if (vendored.length > 0) {
    console.log('');
    console.log(`Refusing to commit: ${vendored.length} of the ${changed.length} changed file(s)`);
    console.log(`are build output, not tests (${vendoredReasons(changed).join(', ')}).`);
    console.log('');
    for (const file of vendored.slice(0, 5)) console.log(`  ${file}`);
    if (vendored.length > 5) console.log(`  … and ${vendored.length - 5} more`);
    console.log('');
    console.log('git has no .gitignore to tell it otherwise, so these count as changes under');
    console.log(
      `${owned.join(' and ')}. Write this to ${displayPath(join(projectRoot, '.gitignore'))}:`,
    );
    console.log('');
    for (const line of gitignoreSuggestion(config.suiteDir).split('\n')) console.log(`  ${line}`);
    console.log('');
    console.log('then re-run. Nothing was changed.');
    process.exitCode = 1;
    return;
  }

  const plans = readAllPlans(projectRoot);
  const report = latestReport(projectRoot);
  const featureIds = plans.map((plan) => plan.featureId);

  const content = buildPrContent({
    plans,
    ...(report !== undefined ? { report } : {}),
    baseUrl: config.baseUrl,
    featureIds,
  });
  const title = opts.title ?? content.title;

  console.log('');
  console.log(`Files to commit (${changed.length}):`);
  for (const file of changed.slice(0, 20)) console.log(`  ${file}`);
  if (changed.length > 20) console.log(`  … and ${changed.length - 20} more`);

  // Reported, never staged. Silence here is how somebody's .env ends up in a PR.
  const untouched = changedOutside(projectRoot, owned);
  if (untouched.length > 0) {
    console.log('');
    console.log(`Leaving ${untouched.length} unrelated change(s) alone:`);
    for (const file of untouched.slice(0, 10)) console.log(`  ${file}`);
    if (untouched.length > 10) console.log(`  … and ${untouched.length - 10} more`);
  }

  if (report === undefined) {
    console.log('');
    console.log('No run report found — the pull request will say the suite was not verified.');
    console.log('Run `flint verify` first if you want the PR to carry evidence.');
  }

  if (opts.dryRun) {
    console.log('');
    console.log(`Title: ${title}`);
    console.log('');
    console.log(content.body);
    console.log('');
    console.log('Dry run — nothing was changed.');
    return;
  }

  // ---- branch + commit (always local) ------------------------------------
  const branch = opts.branch ?? `flint/${stamp()}`;
  if (branchExists(projectRoot, branch)) {
    throw new FlintError(`Branch "${branch}" already exists.`, {
      code: 'PR',
      hint: 'Pass a different --branch, or delete the existing one.',
    });
  }
  const startedOn = currentBranch(projectRoot);
  createBranch(projectRoot, branch);
  const sha = commitPaths(projectRoot, owned, commitMessage(featureIds, report));

  console.log('');
  console.log(`Committed ${sha.slice(0, 8)} on ${branch}`);
  logger.info({ branch, sha, files: changed.length }, 'pr: committed');

  if (!opts.push) {
    // The whole point of the default: hand back the commands rather than
    // running them. Both are copy-pasteable as printed.
    console.log('');
    console.log('Not pushed. To finish:');
    console.log(`  git push -u ${opts.remote} ${branch}`);
    console.log('  flint pr --push --branch ' + branch + `  ${dirFlag(opts.dir)}`);
    console.log('');
    console.log(`Or go back with:  git checkout ${startedOn ?? '-'}`);
    return;
  }

  // ---- push + open the PR ------------------------------------------------
  const url = remoteUrl(projectRoot, opts.remote);
  if (url === undefined) {
    throw new FlintError(`No git remote named "${opts.remote}".`, {
      code: 'PR',
      hint: `The commit is on "${branch}" and is safe. Add the remote, then re-run with --push.`,
    });
  }
  const repo = parseRemote(url);
  const token = findToken();

  const pushed = push(projectRoot, opts.remote, branch);
  if (!pushed.ok) {
    throw new FlintError(`Could not push "${branch}" to ${opts.remote}.`, {
      code: 'PR',
      hint: `git said: ${pushed.stderr}. The commit is safe on your local branch.`,
    });
  }
  console.log(`Pushed ${branch} to ${opts.remote}`);

  if (repo === undefined) {
    console.log('');
    console.log(`${opts.remote} is not a GitHub remote (${url}), so no pull request was opened.`);
    console.log("The branch is pushed — open the request in your host's UI.");
    return;
  }
  if (token === undefined) {
    console.log('');
    console.log('No GITHUB_TOKEN (or GH_TOKEN), so no pull request was opened.');
    console.log('The branch is pushed. Either export a token and re-run, or open it here:');
    console.log(`  https://github.com/${repo.owner}/${repo.repo}/compare/${branch}?expand=1`);
    return;
  }

  const base = opts.base ?? defaultBranch(projectRoot, opts.remote) ?? 'main';
  const created = await createPullRequest({
    token,
    repo,
    head: branch,
    base,
    title,
    body: content.body,
    draft: opts.draft,
  });

  console.log('');
  console.log(`Pull request #${created.number}: ${created.url}`);
}

/**
 * The most recent run report, if there is one.
 *
 * Absent is a normal state, not an error — somebody may have run `ci
 * --no-verify`. The PR body then says the suite was not verified rather than
 * implying it passed.
 */
function latestReport(projectRoot: string): RunReport | undefined {
  const dir = reportsDir(projectRoot);
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort();
  const newest = files[files.length - 1];
  if (newest === undefined) return undefined;
  try {
    const parsed = RunReportSchema.safeParse(
      JSON.parse(readFileSync(resolve(dir, newest), 'utf8')),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    // A malformed report must not stop a pull request; the body just says the
    // suite was not verified, which is the truthful reading.
    return undefined;
  }
}

function dirFlag(dir: string): string {
  return dir === '.' ? '' : `--dir ${dir}`;
}

/** `20260814-004312` — sortable, and unique enough for a branch name. */
function stamp(now: Date = new Date()): string {
  const iso = now.toISOString();
  return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`;
}
