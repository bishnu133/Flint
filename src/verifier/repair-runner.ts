import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { modelPath, readModel } from '../explorer/screen-model-store.js';
import { repairTest, type ProposeRepairInput, type RepairOutcome } from './repair.js';
import { proposeRepair } from './llm-repair.js';
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
    const outcome = await repairOne(failure).catch((err: unknown) => {
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

    byTitle.set(key(outcome.result), outcome.result);
    options.repairs.push(summarise(outcome));
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
          writeFileSync(resolve(options.suiteRoot, relativePath), contents, 'utf8');
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
  const outcome = runSuite({ suiteRoot, grep: escapeForGrep(test.title), logger });
  if (!outcome.ran) return test;
  const match = outcome.tests.find((t) => t.title === test.title);
  return match ?? test;
}

/** Playwright's --grep is a regex; a test title is not. */
export function escapeForGrep(title: string): string {
  return title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function summarise(outcome: RepairOutcome): RepairSummary {
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
  return { title: outcome.result.title, repaired: outcome.repaired, detail };
}
