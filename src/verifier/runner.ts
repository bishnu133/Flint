import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parsePlaywrightReport, type ParsedRun } from './playwright-report.js';
import { silentLogger, type Logger } from '../shared/logger.js';
import { FlintError } from '../shared/errors.js';

/**
 * Runs the generated suite and returns what happened.
 *
 * The one distinction this module exists to preserve: **"tests failed" is not
 * "the run never happened"**. The compile gate learned that the hard way — it
 * silently reported success for weeks because a skip looked like a pass. Here
 * the same idea is `ran`: false means nothing was executed, and no caller may
 * read an empty failure list as a green suite.
 */

export interface RunOptions {
  /** Absolute path of the suite root (where playwright.config lives). */
  suiteRoot: string;
  /** Restrict to tests carrying this grep, e.g. `@feature:login`. */
  grep?: string;
  /** Exclude tests by grep, e.g. `@needs-setup`. */
  grepInvert?: string;
  /** Extra env for the child, merged over the current process env. */
  env?: Record<string, string>;
  /** Wall-clock cap for the whole run. */
  timeoutMs?: number;
  logger?: Logger;
}

export interface RunOutcome extends ParsedRun {
  /**
   * False when the suite could not be executed at all. `tests: []` with
   * `ran: false` means "we know nothing", not "nothing failed".
   */
  ran: boolean;
  /** Why it could not run, when it could not. */
  notRunReason?: string;
  /** Playwright's exit code, when it produced one. */
  exitCode?: number;
}

/** Long enough for a real suite, short enough that CI never hangs on it. */
const DEFAULT_TIMEOUT_MS = 15 * 60_000;

export function runSuite(options: RunOptions): RunOutcome {
  const logger = options.logger ?? silentLogger();

  const configured = ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs'].some(
    (name) => existsSync(join(options.suiteRoot, name)),
  );
  if (!configured) {
    return notRun('the suite has no playwright.config — nothing to run', logger);
  }
  if (!existsSync(join(options.suiteRoot, 'node_modules'))) {
    // Same judgement as the compile gate: an uninstalled suite is the user's
    // environment, not a test failure, and reporting it as failures would put
    // correct tests in front of the repair loop.
    return notRun(
      "the suite's dependencies are not installed — run `npm install` in the suite",
      logger,
    );
  }

  const args = ['playwright', 'test', '--reporter=json'];
  if (options.grep !== undefined && options.grep !== '') args.push('--grep', options.grep);
  if (options.grepInvert !== undefined && options.grepInvert !== '') {
    args.push('--grep-invert', options.grepInvert);
  }

  logger.info({ suiteRoot: options.suiteRoot, args }, 'verify: running the suite');

  const result = spawnSync('npx', args, {
    cwd: options.suiteRoot,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...(options.env ?? {}) },
  });

  if (result.error !== undefined) {
    const timedOut = (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
    return notRun(
      timedOut
        ? `the suite did not finish within ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
        : `could not start Playwright: ${result.error.message}`,
      logger,
    );
  }

  const stdout = result.stdout ?? '';
  // Playwright prints the JSON report to stdout, but anything the tests log
  // lands there too. The report is the last complete JSON object.
  const json = extractJson(stdout);
  if (json === undefined) {
    return {
      ran: false,
      tests: [],
      runErrors: [],
      notRunReason: `Playwright produced no JSON report${
        result.stderr ? `: ${result.stderr.trim().split('\n').slice(0, 3).join(' ')}` : ''
      }`,
      ...(result.status !== null ? { exitCode: result.status } : {}),
    };
  }

  const parsed = parsePlaywrightReport(json);
  return {
    ran: true,
    ...parsed,
    ...(result.status !== null ? { exitCode: result.status } : {}),
  };
}

function notRun(reason: string, logger: Logger): RunOutcome {
  logger.warn({ reason }, 'verify: the suite was not run');
  return { ran: false, tests: [], runErrors: [], notRunReason: reason };
}

/**
 * Pull the report out of stdout.
 *
 * Tests write to stdout too, so the JSON is not guaranteed to be the whole
 * stream. Scanning from the first `{` and brace-matching is enough: the
 * reporter emits one object, and anything before it is noise.
 */
export function extractJson(stdout: string): string | undefined {
  const start = stdout.indexOf('{');
  if (start === -1) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < stdout.length; i += 1) {
    const ch = stdout[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return stdout.slice(start, i + 1);
    }
  }
  return undefined;
}

/** Raised when a caller demands results and the run produced none. */
export function requireRan(outcome: RunOutcome): void {
  if (outcome.ran) return;
  throw new FlintError('The generated suite could not be run.', {
    code: 'VERIFY',
    hint: outcome.notRunReason ?? 'No further detail was available.',
  });
}
