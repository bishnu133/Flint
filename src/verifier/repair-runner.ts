import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { modelPath, readModel } from '../explorer/screen-model-store.js';
import { readMarker, withMarker } from '../indexer/managed.js';
import {
  repairHistoryComment,
  repairTest,
  type ProposeRepairInput,
  type RepairOutcome,
} from './repair.js';
import { proposeRepair } from './llm-repair.js';
import { applyFixme } from './fixme.js';
import { isolationVerdict, markFlaky } from './isolation.js';
import { runSuite, type RunOutcome } from './runner.js';
import type { TestResult } from '../schemas/run-report.js';
import type { LLMProvider } from '../llm/types.js';
import { silentLogger, type Logger } from '../shared/logger.js';

/**
 * Wires the pure repair loop to a real suite on disk.
 *
 * The loop itself (`repair.ts`) knows nothing about files or processes — it is
 * handed `readFile`, `writeFile` and `rerun`. This module supplies those, which
 * keeps every decision the loop makes testable without spawning a browser and
 * keeps the risky part (writing to a user's suite) in one small place.
 */

export interface RepairSummary {
  title: string;
  repaired: boolean;
  /** Lines to print under the title. */
  detail: string[];
}

export interface RepairFailuresOptions {
  projectRoot: string;
  suiteRoot: string;
  outcome: RunOutcome;
  role: string | undefined;
  logger?: Logger;
  /** Collected for the CLI to print. */
  repairs: RepairSummary[];
  /** Titles that failed in the suite but passed alone. Filled in by this call. */
  flaky: string[];
  /**
   * Model-assisted repair. Omitted to run deterministic-only, in which case a
   * failure the selector retry cannot address is declined with that reason.
   */
  llm?: {
    provider: LLMProvider;
    /** `config.models.repair`. */
    modelId: string;
    /** `config.tokenBudgets.repair`. */
    tokenBudget: number;
  };
}

/**
 * Repair every failing test, then return an outcome reflecting the result.
 *
 * Tests are handled one at a time and re-run individually, so a repair to one
 * cannot mask or cause a failure in another.
 */
export async function repairFailures(options: RepairFailuresOptions): Promise<RunOutcome> {
  const logger = options.logger ?? silentLogger();
  const failures = options.outcome.tests.filter((t) => t.status === 'failed');
  if (failures.length === 0) return options.outcome;

  const modelFile = modelPath(options.projectRoot, options.role);
  if (!existsSync(modelFile)) {
    logger.warn(
      { modelFile },
      'repair: no Screen Model — a selector retry needs the verified candidates',
    );
    return options.outcome;
  }
  const model = readModel(modelFile);

  const byTitle = new Map<string, TestResult>();
  for (const test of options.outcome.tests) byTitle.set(key(test), test);

  const llm = options.llm;
  for (const failure of failures) {
    // Establish the test is actually broken before anything patches it. A test
    // that passes alone was disturbed by another test, not written wrong, and
    // patching it would corrupt something that was correct.
    const alone = rerunScoped(options.suiteRoot, failure, logger);
    const verdict = isolationVerdict(alone);
    if (verdict === 'flaky') {
      const flaky = markFlaky(failure);
      byTitle.set(key(flaky), flaky);
      options.flaky.push(failure.title);
      logger.info({ test: failure.title }, 'verify: passed alone — marked flaky, not repaired');
      continue;
    }

    // The isolated run is fresher than the suite run, and its error is the one
    // repair should work from.
    const current = alone ?? failure;

    const outcome = await repairOne(current).catch((err: unknown) => {
      // A provider failure — an expired key, a rate limit, a network drop — must
      // not throw away the run report for the tests that already ran. Record it
      // against this test and carry on with the next.
      const detail = err instanceof Error ? err.message : String(err);
      logger.warn({ test: failure.title, err: detail }, 'repair: aborted for this test');
      return {
        result: failure,
        attempts: [],
        repaired: false,
        gaveUpBecause: `repair could not run: ${detail}`,
      } satisfies RepairOutcome;
    });

    // Last resort: a test repair could not fix becomes `test.fixme` carrying
    // the reason, so the failure is documented where a human will find it
    // rather than only in a report file they may never open.
    // The marker goes in the file, but this run's report still says `failed`.
    // Re-badging it `fixme` here would drop the test out of the pass-rate
    // denominator — a suite could reach 100% by giving up on everything. What
    // happened in this run is that the test failed; the marker is what happens
    // to the *next* run.
    const marked = !outcome.repaired ? writeFixme(options.suiteRoot, outcome, logger) : undefined;

    byTitle.set(key(outcome.result), outcome.result);
    options.repairs.push(summarise(outcome, marked));
  }

  return { ...options.outcome, tests: [...byTitle.values()] };

  async function repairOne(failure: TestResult): Promise<RepairOutcome> {
    return repairTest({
      test: failure,
      model,
      logger,
      deps: {
        readFile: (relativePath) => {
          const abs = resolve(options.suiteRoot, relativePath);
          return existsSync(abs) ? readFileSync(abs, 'utf8') : undefined;
        },
        writeFile: (relativePath, contents) => {
          writeFileSync(resolve(options.suiteRoot, relativePath), restamp(contents), 'utf8');
        },
        pageObjectFiles: () => listPageObjects(options.suiteRoot),
        rerun: (test) => rerunOne(options.suiteRoot, test, logger),
        ...(llm !== undefined
          ? {
              proposeRepair: (input: ProposeRepairInput) =>
                proposeRepair({
                  test: input.test,
                  model: input.model,
                  files: input.files,
                  provider: llm.provider,
                  modelId: llm.modelId,
                  tokenBudget: llm.tokenBudget,
                  logger,
                }),
            }
          : {}),
      },
    });
  }
}

function key(test: TestResult): string {
  return `${test.file}:${test.title}`;
}

/** Page objects, most recently modified first — the likely site of a swap. */
function listPageObjects(suiteRoot: string): string[] {
  const dir = join(suiteRoot, 'pages');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.page.ts'))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => join('pages', name));
}

/**
 * Re-run exactly one test.
 *
 * Scoped by the test's own title so a repair is judged on the test it changed
 * and nothing else. A title Playwright cannot match returns the test unchanged,
 * which the loop reads as "still failing" — the safe direction, since claiming
 * a repair worked when it was never re-run would be the worst outcome here.
 */
function rerunOne(suiteRoot: string, test: TestResult, logger: Logger): TestResult {
  return rerunScoped(suiteRoot, test, logger) ?? test;
}

/**
 * Re-run one test, or report that it could not be run.
 *
 * `undefined` is the honest answer when the run did not happen or the title
 * matched nothing — never the test's old result dressed up as a fresh one. The
 * isolation check needs that distinction: "passed alone" and "we could not find
 * out" must not collapse into the same value.
 */
function rerunScoped(suiteRoot: string, test: TestResult, logger: Logger): TestResult | undefined {
  const outcome = runSuite({ suiteRoot, grep: escapeForGrep(test.title), logger });
  if (!outcome.ran) return undefined;
  return outcome.tests.find((t) => t.title === test.title);
}

/** Playwright's --grep is a regex; a test title is not. */
export function escapeForGrep(title: string): string {
  return title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Write the fixme marker and its comment block into the spec.
 *
 * Returns true when the file changed, false when it did not, and undefined when
 * the file could not be read. Idempotence lives in `applyFixme`; this only has
 * to not lie about what it did.
 */
function writeFixme(
  suiteRoot: string,
  outcome: RepairOutcome,
  logger: Logger,
): boolean | undefined {
  const abs = resolve(suiteRoot, outcome.result.file);
  if (!existsSync(abs)) {
    logger.warn({ file: outcome.result.file }, 'repair: cannot mark fixme — spec file not found');
    return undefined;
  }
  const source = readFileSync(abs, 'utf8');
  const applied = applyFixme(source, outcome.result.title, repairHistoryComment(outcome));
  if (!applied.changed) {
    logger.info(
      { test: outcome.result.title, reason: applied.reason },
      'repair: fixme marker not written',
    );
    return false;
  }
  writeFileSync(abs, restamp(applied.source), 'utf8');
  logger.info({ test: outcome.result.title, file: outcome.result.file }, 'repair: marked fixme');
  return true;
}

/**
 * Re-stamp the managed marker after repair rewrites a file.
 *
 * Without this, repair is a hand edit as far as the rest of Flint is concerned.
 * The marker records a hash of the content; repair changes the content and
 * leaves the old hash, so `classify()` returns `hand-edited`, the next `flint
 * ci` diverts the file to `*.flint.ts` rather than overwriting it, and the
 * compile gate then fails forever — the regenerated specs are checked against
 * the repaired file, which no longer has the members they use. A real run got
 * stuck exactly this way, and the operator was told they had edited a file they
 * had never opened.
 *
 * Files Flint does not own are left alone: `withMarker` on an unmarked file
 * would claim ownership of somebody's hand-written page object, which is worse
 * than the problem it solves. Repair is allowed to fix those; it is not allowed
 * to adopt them.
 */
export function restamp(contents: string): string {
  return readMarker(contents) === undefined ? contents : withMarker(contents);
}

function summarise(outcome: RepairOutcome, marked: boolean | undefined): RepairSummary {
  const detail: string[] = [];
  for (const attempt of outcome.attempts) {
    detail.push(`${attempt.iteration}. [${attempt.kind}] ${attempt.summary}`);
  }
  if (!outcome.repaired && outcome.gaveUpBecause !== undefined) {
    detail.push(outcome.gaveUpBecause);
  }
  if (outcome.result.possibleAppDefect === true) {
    detail.push('assertion mismatch survived repair — check the application, not the test');
  }
  if (marked === true) detail.push('marked test.fixme with the repair history');
  return { title: outcome.result.title, repaired: outcome.repaired, detail };
}
