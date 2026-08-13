import type { FailureClass, TestResult } from '../schemas/run-report.js';
import type { ScreenModel } from '../schemas/screen-model.js';
import { deservesSelectorRetry, isRepairable, mayBeAppDefect } from './classifier.js';
import {
  applySwap,
  elementForSelector,
  failingSelector,
  nextSelector,
  swapSelector,
} from './selector-retry.js';
import { locatorExpression } from '../generator/dialects/playwright-pom.js';
import type { SelectorStrategy } from '../shared/selector-ranking.js';
import { silentLogger, type Logger } from '../shared/logger.js';
import type { RepairFile, ValidatedRepair } from './llm-repair.js';

/**
 * The repair loop.
 *
 * Two hard limits, both from the master plan and both LOCKED:
 *
 * - **at most 2 iterations per test**, and
 * - **a wall-clock budget per test**,
 *
 * because a repair loop with either missing is how a tool spends an afternoon
 * and a fortune rewriting a suite into something nobody asked for. The caps are
 * enforced here rather than trusted to the caller.
 *
 * Ordering is the other rule: `selector-not-found` retries deterministically
 * with the next verified candidate **before** any model is consulted. That
 * attempt is free, instant, and cannot invent a selector — the replacement was
 * confirmed against the live page during exploration. Only when the
 * deterministic path has nothing left to try does a model get asked, and what
 * it proposes is checked in code before anything is written (`llm-repair.ts`).
 *
 * The two paths are also cleaned up differently, on purpose. A failed
 * selector-retry swap is left in place: it put a *verified* selector in the
 * file, which is the same class of thing the Emitter writes, and the next
 * `flint generate` restores the canonical form. A failed model patch is
 * **reverted**, because leaving unreviewed model-authored code in a suite that
 * is still failing is worse than the failure.
 *
 * ## What this loop must never do
 *
 * Four times in Phase 4, Flint treated its own previous output as somebody
 * else's input, and each time the result was silent damage. The equivalent
 * mistake here is the loop reading its own last patch as the user's code and
 * "preserving" it, or counting its own attempt as evidence. So: the attempt
 * history is threaded explicitly, every selector already tried is remembered,
 * and a patch is only kept if the re-run actually passes.
 */

/** LOCKED by the master plan. Not a tunable. */
export const MAX_REPAIR_ITERATIONS = 2;

/** Default wall-clock budget for repairing one test. */
export const DEFAULT_PER_TEST_BUDGET_MS = 5 * 60_000;

export interface RepairAttempt {
  iteration: number;
  /** How the patch was produced. */
  kind: 'selector-retry' | 'llm';
  /** What changed, in one line, for the repair history in the report. */
  summary: string;
  /** Whether the re-run passed afterwards. */
  passed: boolean;
}

export interface RepairOutcome {
  /** The test as it stands after repair — passed, or still failed. */
  result: TestResult;
  attempts: RepairAttempt[];
  /** True when a patch was kept because the re-run passed. */
  repaired: boolean;
  /** Why the loop stopped, when it stopped without success. */
  gaveUpBecause?: string;
}

/** Everything the model is asked about, and what it proposed back. */
export interface ProposeRepairInput {
  test: TestResult;
  model: ScreenModel;
  /** The spec and its page objects, as they stand right now. */
  files: RepairFile[];
}

export interface ProposeRepairOutput {
  /** A patch that survived every check. Absent when nothing is to be applied. */
  applied?: ValidatedRepair;
  /** Why there is no patch — a refusal worth putting in the report. */
  rejected?: string;
}

/** What the loop needs from the outside world, injected so it stays testable. */
export interface RepairDeps {
  /** Current contents of a suite file, or undefined when it is not there. */
  readFile: (relativePath: string) => string | undefined;
  /** Write a patched file. Only called when a patch is being applied. */
  writeFile: (relativePath: string, contents: string) => void;
  /** Re-run exactly one test. Returns its fresh result. */
  rerun: (test: TestResult) => TestResult;
  /** Page-object files that might hold the failing locator, in search order. */
  pageObjectFiles: () => string[];
  /**
   * Ask a model for a repair. Omitted when no provider is configured, in which
   * case the loop declines instead of pretending it tried something.
   */
  proposeRepair?: (input: ProposeRepairInput) => Promise<ProposeRepairOutput>;
  now?: () => number;
}

export interface RepairOptions {
  test: TestResult;
  model: ScreenModel;
  deps: RepairDeps;
  budgetMs?: number;
  logger?: Logger;
}

/**
 * Attempt to repair one failing test.
 *
 * Returns the test unchanged, with a reason, whenever repair is not appropriate
 * — which is most of the time. The loop is deliberately reluctant: a test that
 * is left failing tells a human something true, while a test that was patched
 * into passing may not.
 */
export async function repairTest(options: RepairOptions): Promise<RepairOutcome> {
  const logger = options.logger ?? silentLogger();
  const now = options.deps.now ?? (() => Date.now());
  const deadline = now() + (options.budgetMs ?? DEFAULT_PER_TEST_BUDGET_MS);

  const failureClass = options.test.failureClass;
  if (options.test.status !== 'failed' || failureClass === undefined) {
    return notAttempted(options.test, 'the test did not fail');
  }
  if (!isRepairable(failureClass)) {
    return notAttempted(options.test, reasonNotRepairable(failureClass));
  }

  const attempts: RepairAttempt[] = [];
  // Every selector this loop has already put in front of the browser. Without
  // it the next iteration would happily re-propose the one that just failed.
  const tried: string[] = [];

  let current = options.test;

  for (let iteration = 1; iteration <= MAX_REPAIR_ITERATIONS; iteration += 1) {
    if (now() >= deadline) {
      return giveUp(
        current,
        attempts,
        `the ${msLabel(options.budgetMs)} budget for this test ran out`,
      );
    }

    // The deterministic path first, always, and only when the failure class is
    // one it can address. Anything else falls through to the model.
    const thisClass = current.failureClass ?? failureClass;
    const selectorApplies = deservesSelectorRetry(thisClass);
    const patch = selectorApplies
      ? planSelectorRetry(current, options.model, options.deps, tried)
      : undefined;

    // Why the deterministic path produced nothing, said precisely — "it does
    // not apply to this failure" and "it ran out of selectors" are different
    // facts, and a human reading the report needs to know which.
    const exhausted = selectorApplies
      ? 'no other verified selector was available to try'
      : `no deterministic repair applies to a ${thisClass} failure`;

    const applied =
      patch !== undefined
        ? applySelectorRetry(patch, tried, options.deps, logger, current, iteration)
        : await applyModelRepair(current, options, logger, iteration, exhausted);

    if (applied.kind === 'declined') {
      return giveUp(current, attempts, applied.because);
    }

    const rerun = options.deps.rerun(current);
    const passed = rerun.status === 'passed';
    attempts.push({ iteration, kind: applied.attemptKind, summary: applied.summary, passed });

    if (passed) {
      return { result: { ...rerun, repairAttempts: attempts.length }, attempts, repaired: true };
    }

    // A model patch that did not work is reverted; a verified-selector swap is
    // not. See the note at the top of this file.
    if (applied.revert !== undefined) {
      applied.revert();
      logger.info({ test: current.title, iteration }, 'repair: reverted a model patch that failed');
    }
    current = { ...rerun, repairAttempts: attempts.length };
  }

  return giveUp(
    current,
    attempts,
    `still failing after ${MAX_REPAIR_ITERATIONS} attempts (the locked maximum)`,
  );
}

/** One iteration's worth of work: either something was written, or it was not. */
type AppliedPatch =
  | { kind: 'declined'; because: string }
  | {
      kind: 'applied';
      attemptKind: RepairAttempt['kind'];
      summary: string;
      /** Present only when the patch must be undone if the re-run fails. */
      revert?: () => void;
    };

function applySelectorRetry(
  patch: SelectorPatch,
  tried: string[],
  deps: RepairDeps,
  logger: Logger,
  test: TestResult,
  iteration: number,
): AppliedPatch {
  tried.push(patch.triedValue);
  deps.writeFile(patch.file, patch.patched);
  logger.info(
    { test: test.title, iteration, file: patch.file, selector: patch.triedValue },
    'repair: retrying with the next verified selector',
  );
  return { kind: 'applied', attemptKind: 'selector-retry', summary: patch.summary };
}

/**
 * Ask the model, check what it said, and write only if it survives.
 *
 * The snapshot taken before writing is what makes a failed model patch
 * reversible. It is captured from the files as they are *now*, which includes
 * any selector swap an earlier iteration made — reverting undoes this patch,
 * not the whole loop.
 */
async function applyModelRepair(
  test: TestResult,
  options: RepairOptions,
  logger: Logger,
  iteration: number,
  exhausted: string,
): Promise<AppliedPatch> {
  const { deps } = options;
  if (deps.proposeRepair === undefined) {
    return {
      kind: 'declined',
      because: `${exhausted}, and no model is configured for repair (set ANTHROPIC_API_KEY)`,
    };
  }

  const files = editableFiles(test, deps);
  if (files.length === 0) {
    return { kind: 'declined', because: 'none of the files this test uses could be read' };
  }

  const proposal = await deps.proposeRepair({ test, model: options.model, files });
  const applied = proposal.applied;
  if (applied === undefined) {
    return {
      kind: 'declined',
      because: `${exhausted}; ${proposal.rejected ?? 'the model proposed no repair'}`,
    };
  }

  const snapshot = new Map(files.map((f) => [f.path, f.contents]));
  for (const file of applied.files) deps.writeFile(file.path, file.contents);
  logger.info(
    { test: test.title, iteration, files: applied.files.map((f) => f.path) },
    'repair: applied a model patch',
  );

  return {
    kind: 'applied',
    attemptKind: 'llm',
    summary: applied.diagnosis,
    revert: () => {
      for (const file of applied.files) {
        const original = snapshot.get(file.path);
        if (original !== undefined) deps.writeFile(file.path, original);
      }
    },
  };
}

/**
 * The spec plus its page objects — the only files a repair may touch.
 *
 * Deliberately narrow. A repair that can edit anything in the suite is a repair
 * that can break tests it was never asked to look at.
 */
function editableFiles(test: TestResult, deps: RepairDeps): RepairFile[] {
  const paths = [test.file, ...deps.pageObjectFiles()];
  const files: RepairFile[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    const contents = deps.readFile(path);
    if (contents !== undefined) files.push({ path, contents });
  }
  return files;
}

interface SelectorPatch {
  file: string;
  patched: string;
  triedValue: string;
  summary: string;
}

function planSelectorRetry(
  test: TestResult,
  model: ScreenModel,
  deps: RepairDeps,
  tried: readonly string[],
): SelectorPatch | undefined {
  const selector = failingSelector(test.errorExcerpt);
  if (selector === undefined) return undefined;

  const element = elementForSelector(model, selector);
  if (element === undefined) return undefined;

  const alreadyTried = [...new Set([selector, ...tried])];
  const next = nextSelector(element, alreadyTried);
  if (next === undefined) return undefined;

  // The failing expression as it appears in the page object. Rebuilding it from
  // the previous candidate is what lets the swap be an exact string match
  // rather than a regex over generated code.
  const previous = next.previous;
  if (previous === undefined) return undefined;
  const oldExpression = expressionFor(previous.strategy, previous.value);

  for (const file of deps.pageObjectFiles()) {
    const source = deps.readFile(file);
    if (source === undefined) continue;
    const swap = swapSelector(source, oldExpression, next.expression);
    if (swap === undefined) continue;
    return {
      file,
      patched: applySwap(source, swap),
      triedValue: next.next.value,
      summary: `${element.id}: ${previous.strategy} -> ${next.next.strategy}`,
    };
  }
  return undefined;
}

/**
 * The failing expression exactly as the Emitter wrote it.
 *
 * Rebuilding it through the dialect rather than pattern-matching the generated
 * code is what lets the swap be an exact string replacement: if the dialect
 * ever changes how it renders a locator, this moves with it.
 */
function expressionFor(strategy: SelectorStrategy, value: string): string {
  return locatorExpression({ strategy, value, score: 0, elementId: '', description: '' });
}

function notAttempted(test: TestResult, because: string): RepairOutcome {
  return { result: test, attempts: [], repaired: false, gaveUpBecause: because };
}

function giveUp(test: TestResult, attempts: RepairAttempt[], because: string): RepairOutcome {
  return {
    result: {
      ...test,
      repairAttempts: attempts.length,
      // An assertion mismatch that survives repair is the headline finding, not
      // a footnote: the application may genuinely be wrong.
      ...(test.failureClass !== undefined && mayBeAppDefect(test.failureClass)
        ? { possibleAppDefect: true }
        : {}),
    },
    attempts,
    repaired: false,
    gaveUpBecause: because,
  };
}

function reasonNotRepairable(failureClass: FailureClass): string {
  return failureClass === 'env'
    ? 'the failure is environmental — patching a test cannot fix an unreachable application'
    : 'the failure could not be classified, and a blind edit is how a repair loop corrupts a suite';
}

function msLabel(budgetMs: number | undefined): string {
  const ms = budgetMs ?? DEFAULT_PER_TEST_BUDGET_MS;
  return ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`;
}

/**
 * The comment block a still-failing test carries into the suite.
 *
 * Everything a human needs to decide what to do, in the file where they will
 * find the problem: what class of failure it was, what the loop tried, and the
 * last error. A bare `test.fixme` with no explanation is how a suite silently
 * accumulates dead tests.
 */
export function repairHistoryComment(outcome: RepairOutcome): string[] {
  const lines: string[] = [];
  const { result, attempts } = outcome;
  lines.push(`Flint could not repair this test (${result.failureClass ?? 'unknown'}).`);
  if (outcome.gaveUpBecause !== undefined) lines.push(`Gave up because ${outcome.gaveUpBecause}.`);

  if (attempts.length > 0) {
    lines.push('');
    lines.push('Repair attempts:');
    for (const attempt of attempts) {
      lines.push(`  ${attempt.iteration}. [${attempt.kind}] ${attempt.summary} — still failing`);
    }
  }

  if (result.possibleAppDefect === true) {
    lines.push('');
    lines.push('This is an assertion mismatch that survived repair: the application');
    lines.push('produced a value other than the one expected. Check the application');
    lines.push('before changing the test — this may be a real defect.');
  }

  if (result.errorExcerpt !== undefined) {
    lines.push('');
    lines.push('Last error:');
    for (const line of result.errorExcerpt.split('\n').slice(0, 10)) lines.push(`  ${line}`);
  }
  return lines;
}
