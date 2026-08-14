import { Octokit } from '@octokit/rest';
import { FlintError } from '../shared/errors.js';

/**
 * Opening the pull request.
 *
 * Uses octokit rather than shelling out to `gh`: no external binary to install,
 * and it behaves the same in CI as on a laptop. The `gh` CLI would also mean
 * inheriting whatever account someone happened to be logged into, which is a
 * surprising way to decide who authored a PR.
 *
 * Flint **never pushes unless asked.** `flint pr` commits locally and prints
 * the commands; `--push` is what makes it touch a remote. A test generator that
 * pushes to somebody's repository as a side effect of generating tests is a bad
 * default, and the blast radius of getting it wrong is a branch on their origin.
 */

export interface Repo {
  owner: string;
  repo: string;
}

/**
 * Parse `owner/repo` out of a git remote URL.
 *
 * Handles the forms in the wild: HTTPS, SSH, and `git://`. Returns undefined
 * rather than throwing — a remote pointing somewhere else is a reason to skip
 * PR creation with a clear message, not to crash.
 *
 * **The host must be github.com exactly.** A GitHub Enterprise remote such as
 * `github.mycorp.com` also yields an `owner/repo` pair, and octokit — pointed
 * at api.github.com by default — would then try to open the pull request
 * against the *public* repository of that name. Refusing to parse is what
 * makes the caller say "not a GitHub remote; your branch is pushed, open it in
 * your host's UI" instead of doing something surprising on a stranger's repo.
 */
export function parseRemote(url: string): Repo | undefined {
  const cleaned = url.trim().replace(/\.git$/, '');
  const patterns = [
    /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)$/,
    /^git@github\.com:([^/]+)\/([^/]+)$/,
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)$/,
    /^git:\/\/github\.com\/([^/]+)\/([^/]+)$/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(cleaned);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      return { owner: match[1], repo: match[2] };
    }
  }
  return undefined;
}

/** The token, from the usual env vars. Undefined means "do the local half". */
export function findToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const token = env['GITHUB_TOKEN'] ?? env['GH_TOKEN'];
  return token === undefined || token.trim() === '' ? undefined : token.trim();
}

export interface CreatePrOptions {
  token: string;
  repo: Repo;
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
}

export interface CreatedPr {
  number: number;
  url: string;
}

export async function createPullRequest(options: CreatePrOptions): Promise<CreatedPr> {
  const octokit = new Octokit({ auth: options.token });
  try {
    const response = await octokit.pulls.create({
      owner: options.repo.owner,
      repo: options.repo.repo,
      head: options.head,
      base: options.base,
      title: options.title,
      body: options.body,
      draft: options.draft,
    });
    return { number: response.data.number, url: response.data.html_url };
  } catch (err) {
    throw new FlintError(`GitHub refused to open the pull request: ${describe(err)}`, {
      code: 'PR',
      // The branch is already pushed at this point, so the work is not lost —
      // say so, or the operator assumes they have to start over.
      hint:
        `The branch "${options.head}" is pushed, so nothing is lost. Open the PR by hand, ` +
        `or check that the token has \`repo\` scope on ${options.repo.owner}/${options.repo.repo}.`,
      cause: err,
    });
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
