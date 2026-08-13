import { z } from 'zod';
import type { Element, ScreenModel } from '../schemas/screen-model.js';
import type { FailureClass, TestResult } from '../schemas/run-report.js';
import { loadAndRender } from '../generator/template-loader.js';
import { locatorExpression } from '../generator/dialects/playwright-pom.js';
import { estimateTokens } from '../planner/context-builder.js';
import { StructuredOutputError } from '../shared/errors.js';
import { silentLogger, type Logger } from '../shared/logger.js';
import type { LLMProvider } from '../llm/types.js';

/**
 * The model-assisted half of repair, which runs only after the deterministic
 * half has been tried and declined.
 *
 * ## Why this module is mostly validation
 *
 * A repair loop with a model in it is the most dangerous component in Flint,
 * because its failure mode is a **passing test**. Everything else in the
 * pipeline fails loudly when it is wrong; this can quietly delete the thing a
 * test was checking and report success. So the model is treated as an untrusted
 * source of suggestions, and every suggestion is checked in code before a byte
 * is written:
 *
 * - **No invented selectors.** Any locator introduced by an edit must be one the
 *   explorer verified against the live page. A model-authored selector that was
 *   never verified either matches nothing or — far worse — matches the wrong
 *   element and passes.
 * - **No weakened assertions.** Rewriting `expect('Welcome')` to `expect('Error')`
 *   because the app produced "Error" makes the test pass and destroys its only
 *   purpose. That case is also the one where the application may genuinely be
 *   broken, which is the finding Flint exists to surface.
 * - **No skipping.** `test.skip`, `test.fixme`, a deleted assertion or a
 *   swallowing `try`/`catch` are all "make the red go away" moves. Flint decides
 *   when to give up; the model does not.
 * - **Exact-match edits only.** Edits are single-occurrence string replacements,
 *   so a repair cannot rewrite a file wholesale under the guise of a fix.
 *
 * The prompt states all of these too. The prompt is the request; this file is
 * the enforcement. Only the second one is load-bearing.
 */

/** The model's response shape. Internal to this module — not a stored artifact. */
const EditSchema = z
  .object({
    file: z.string().min(1),
    find: z.string().min(1),
    replace: z.string(),
  })
  .strict();

export const RepairProposalSchema = z
  .object({
    diagnosis: z.string(),
    edits: z.array(EditSchema),
  })
  .strict();

export type RepairProposal = z.infer<typeof RepairProposalSchema>;

/** A file as it exists now, and the path the model should refer to it by. */
export interface RepairFile {
  path: string;
  contents: string;
}

/** The result of validating and applying a proposal. */
export interface ValidatedRepair {
  diagnosis: string;
  /** Full new contents per file. Empty when the model declined. */
  files: Array<{ path: string; contents: string }>;
}

export interface RejectedRepair {
  /** Why the proposal was thrown away, in a sentence a human can act on. */
  reason: string;
}

export type ProposalCheck = ({ ok: true } & ValidatedRepair) | ({ ok: false } & RejectedRepair);

/**
 * Every locator expression the Screen Model can justify.
 *
 * Both roots are rendered because a page object writes `this.page.…` and a spec
 * writes `page.…`, and the model may legitimately move a locator between them.
 */
export function verifiedExpressions(model: ScreenModel): Set<string> {
  const allowed = new Set<string>();
  for (const page of model.pages) {
    for (const element of page.elements) {
      for (const candidate of element.selectorCandidates) {
        if (!candidate.verified || !candidate.unique) continue;
        const selector = {
          strategy: candidate.strategy,
          value: candidate.value,
          score: candidate.score,
          elementId: element.id,
          description: '',
        };
        allowed.add(normalise(locatorExpression(selector, 'this.page')));
        allowed.add(normalise(locatorExpression(selector, 'page')));
      }
    }
  }
  return allowed;
}

/** Collapse whitespace so formatting differences do not defeat the check. */
function normalise(expression: string): string {
  return expression.replace(/\s+/g, ' ').trim();
}

/**
 * Locator calls appearing in a chunk of code.
 *
 * Matches the call and its argument list up to the closing paren of the call —
 * good enough because generated locators never nest a call inside their
 * arguments. Anything this misses is caught by the fact that an unrecognised
 * locator simply will not be in the allowed set.
 */
const LOCATOR_CALL =
  /(?:\w+(?:\.\w+)*)\.(?:locator|getByRole|getByLabel|getByPlaceholder|getByText|getByTestId|getByTitle|getByAltText)\([^)]*\)/g;

export function locatorCalls(code: string): string[] {
  return (code.match(LOCATOR_CALL) ?? []).map(normalise);
}

/**
 * True when an edit introduces a locator the explorer never verified.
 *
 * A locator already present in the file is fine wherever it moves to — the
 * concern is *new* selectors, which is the only way an unverified one can enter
 * the suite.
 */
export function introducesUnverifiedSelector(
  find: string,
  replace: string,
  fileContents: string,
  allowed: ReadonlySet<string>,
): string | undefined {
  const before = new Set([...locatorCalls(find), ...locatorCalls(fileContents)]);
  for (const call of locatorCalls(replace)) {
    if (before.has(call)) continue;
    if (allowed.has(call)) continue;
    return call;
  }
  return undefined;
}

/** Playwright's own escape hatches, plus the hand-rolled equivalents. */
const SKIP_MARKERS = [
  'test.skip',
  'test.fixme',
  'test.only',
  'testInfo.skip',
  'it.skip',
  'describe.skip',
];

/** True when an edit makes the test stop testing rather than start passing. */
export function disablesTest(find: string, replace: string): string | undefined {
  for (const marker of SKIP_MARKERS) {
    if (replace.includes(marker) && !find.includes(marker)) return marker;
  }
  // A catch that does nothing turns any failure into a pass.
  if (/catch\s*(?:\([^)]*\))?\s*\{\s*\}/.test(replace)) return 'an empty catch block';
  // Removing assertions without adding any is the silent version of the same.
  const removed = countExpects(find) - countExpects(replace);
  if (removed > 0) return `${removed} removed assertion(s)`;
  return undefined;
}

function countExpects(code: string): number {
  return (code.match(/\bexpect\s*\(/g) ?? []).length;
}

/**
 * The value the application actually produced, per Playwright's error output.
 *
 * Playwright prints the mismatch as `Expected: …` / `Received: …` (or
 * `Expected string`/`Received string`). The received value is what a lazy repair
 * would paste into the assertion.
 */
export function receivedValue(errorExcerpt: string | undefined): string | undefined {
  if (errorExcerpt === undefined) return undefined;
  const match = /Received(?:\s+\w+)?:\s*"((?:[^"\\]|\\.)*)"/.exec(errorExcerpt);
  if (match?.[1] !== undefined) return unescapeJs(match[1]);
  const bare = /Received(?:\s+\w+)?:\s*(.+)/.exec(errorExcerpt);
  return bare?.[1]?.trim();
}

function unescapeJs(text: string): string {
  return text.replace(/\\(.)/g, '$1');
}

/**
 * True when an edit rewrites an expectation to match whatever the app produced.
 *
 * The most damaging possible "repair": the test goes green, the finding
 * disappears, and a real application defect ships. Detected structurally — the
 * received value appearing in the replacement but not in the original — which
 * catches it regardless of how the edit is phrased.
 */
export function weakensAssertion(
  find: string,
  replace: string,
  errorExcerpt: string | undefined,
): string | undefined {
  const received = receivedValue(errorExcerpt);
  if (received === undefined || received.trim() === '') return undefined;
  if (find.includes(received)) return undefined;
  if (!replace.includes(received)) return undefined;
  return received;
}

export interface ValidateOptions {
  proposal: RepairProposal;
  files: readonly RepairFile[];
  model: ScreenModel;
  failureClass: FailureClass | undefined;
  errorExcerpt: string | undefined;
}

/**
 * Check a proposal against every rule, then apply it in memory.
 *
 * All-or-nothing: one bad edit rejects the whole proposal. A partially applied
 * repair is a file in a state neither Flint nor the model intended, and that is
 * strictly worse than the failing test we started with.
 */
export function validateProposal(options: ValidateOptions): ProposalCheck {
  const { proposal } = options;
  if (proposal.edits.length === 0) {
    return { ok: true, diagnosis: proposal.diagnosis, files: [] };
  }

  const allowed = verifiedExpressions(options.model);
  const byPath = new Map(options.files.map((f) => [f.path, f.contents]));
  const working = new Map(byPath);

  for (const edit of proposal.edits) {
    const current = working.get(edit.file);
    if (current === undefined) {
      return {
        ok: false,
        reason: `the model tried to edit "${edit.file}", which is not one of the files it was shown`,
      };
    }

    const occurrences = current.split(edit.find).length - 1;
    if (occurrences === 0) {
      return {
        ok: false,
        reason: `the model's edit to ${edit.file} did not match the file — it quoted text that is not there`,
      };
    }
    if (occurrences > 1) {
      return {
        ok: false,
        reason: `the model's edit to ${edit.file} matched ${occurrences} places, so where it meant is ambiguous`,
      };
    }

    const disabled = disablesTest(edit.find, edit.replace);
    if (disabled !== undefined) {
      return {
        ok: false,
        reason: `the model tried to disable the test rather than fix it (${disabled})`,
      };
    }

    const weakened = weakensAssertion(edit.find, edit.replace, options.errorExcerpt);
    if (weakened !== undefined) {
      return {
        ok: false,
        reason:
          `the model rewrote the expectation to match what the application produced ` +
          `("${weakened}"), which deletes what the test was checking — the application ` +
          `may be the thing that is wrong`,
      };
    }

    const invented = introducesUnverifiedSelector(edit.find, edit.replace, current, allowed);
    if (invented !== undefined) {
      return {
        ok: false,
        reason: `the model invented a selector the explorer never verified: ${invented}`,
      };
    }

    working.set(edit.file, current.split(edit.find).join(edit.replace));
  }

  const changed = [...working.entries()]
    .filter(([path, contents]) => contents !== byPath.get(path))
    .map(([path, contents]) => ({ path, contents }));

  if (changed.length === 0) {
    return { ok: false, reason: 'the model returned edits that changed nothing' };
  }
  return { ok: true, diagnosis: proposal.diagnosis, files: changed };
}

/** Render the verified elements for the prompt, strongest selector first. */
export function renderElements(model: ScreenModel, limit: number): string {
  const lines: string[] = [];
  for (const page of model.pages) {
    const usable = page.elements.filter((e) =>
      e.selectorCandidates.some((c) => c.verified && c.unique),
    );
    if (usable.length === 0) continue;
    lines.push(`### ${page.urlPattern} (${page.title})`);
    for (const element of usable.slice(0, limit)) {
      lines.push(`- ${describe(element)}`);
      for (const candidate of element.selectorCandidates.filter((c) => c.verified && c.unique)) {
        const expression = locatorExpression(
          {
            strategy: candidate.strategy,
            value: candidate.value,
            score: candidate.score,
            elementId: element.id,
            description: '',
          },
          'this.page',
        );
        lines.push(`    ${expression}   // ${candidate.strategy}, score ${candidate.score}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function describe(element: Element): string {
  const name = element.name === '' ? '(no accessible name)' : `"${element.name}"`;
  return `${element.id} — ${element.role} ${name}`;
}

/** Render the editable files for the prompt. */
export function renderFiles(files: readonly RepairFile[]): string {
  return files
    .map((file) => ['#### ' + file.path, '```ts', file.contents.trimEnd(), '```', ''].join('\n'))
    .join('\n');
}

export interface ProposeOptions {
  test: TestResult;
  model: ScreenModel;
  files: readonly RepairFile[];
  provider: LLMProvider;
  /** `config.models.repair`. */
  modelId: string;
  /** `config.tokenBudgets.repair`. */
  tokenBudget: number;
  logger?: Logger;
}

/** Elements per page in the prompt before the budget starts trimming. */
const MAX_ELEMENTS_PER_PAGE = 40;
const MIN_ELEMENTS_PER_PAGE = 5;

/**
 * Ask the model for a repair, then refuse it unless it survives every check.
 *
 * Returns `undefined` when there is nothing to apply — the model declined, the
 * call failed, or the proposal was rejected. The reason is logged and returned
 * so the loop can put it in the report; a repair that was refused for a good
 * reason is information a human wants, not a silent no-op.
 */
export async function proposeRepair(
  options: ProposeOptions,
): Promise<{ applied?: ValidatedRepair; rejected?: string }> {
  const logger = options.logger ?? silentLogger();

  let limit = MAX_ELEMENTS_PER_PAGE;
  let prompt = renderPrompt(options, limit);
  while (estimateTokens(prompt) > options.tokenBudget && limit > MIN_ELEMENTS_PER_PAGE) {
    limit = Math.max(MIN_ELEMENTS_PER_PAGE, Math.floor(limit / 2));
    prompt = renderPrompt(options, limit);
  }
  if (estimateTokens(prompt) > options.tokenBudget) {
    logger.warn(
      { budget: options.tokenBudget, estimated: estimateTokens(prompt) },
      'repair: prompt exceeds the token budget even at the minimum element count',
    );
  }

  const result = await options.provider
    .structured(RepairProposalSchema, {
      model: options.modelId,
      prompt,
      // A repair must be reproducible: the same failure and the same files
      // should not yield a different patch on a re-run.
      temperature: 0,
      meta: { stage: 'repair', purpose: `repair "${options.test.title}"` },
    })
    .catch((err: unknown) => {
      if (err instanceof StructuredOutputError) {
        logger.warn({ err: err.message }, 'repair: the model returned an unusable shape');
        return undefined;
      }
      throw err;
    });

  if (result === undefined) {
    return { rejected: 'the model did not return a usable repair proposal' };
  }

  const check = validateProposal({
    proposal: result.data,
    files: options.files,
    model: options.model,
    failureClass: options.test.failureClass,
    errorExcerpt: options.test.errorExcerpt,
  });

  if (!check.ok) {
    logger.warn({ reason: check.reason }, 'repair: rejected the model proposal');
    return { rejected: check.reason };
  }
  if (check.files.length === 0) {
    return { rejected: `the model declined to patch it: ${check.diagnosis}` };
  }
  logger.info(
    { diagnosis: check.diagnosis, files: check.files.length },
    'repair: proposal accepted',
  );
  return { applied: check };
}

function renderPrompt(options: ProposeOptions, elementLimit: number): string {
  return loadAndRender('repair', {
    title: options.test.title,
    failureClass: options.test.failureClass ?? 'unknown',
    errorExcerpt: options.test.errorExcerpt ?? '(no error text was captured)',
    files: renderFiles(options.files),
    elements: renderElements(options.model, elementLimit),
  }).text;
}
