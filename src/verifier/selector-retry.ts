import type { Element, ScreenModel, SelectorCandidate } from '../schemas/screen-model.js';
import { sortCandidates } from '../explorer/selector-ranker.js';
import { locatorExpression } from '../generator/dialects/playwright-pom.js';

/**
 * The deterministic half of repair, which runs **before** any LLM call.
 *
 * The master plan is explicit about the ordering: a `selector-not-found`
 * failure first retries with the next verified candidate from the Screen Model.
 * That is free, instant, and cannot invent anything — the replacement selector
 * was confirmed against the live page during exploration, exactly like the one
 * it replaces. Spending a model call before trying it would be slower, costlier
 * and strictly less trustworthy.
 *
 * Everything here is pure. The repair loop supplies the error text and the
 * model; this module decides what the next selector should be, and the caller
 * decides whether to write it.
 */

/**
 * Pull the selector out of a Playwright error.
 *
 * Playwright reports the locator it was waiting for in a small number of
 * shapes. Only the ones it actually emits are matched — inventing patterns here
 * would produce a function that looks thorough and never fires.
 */
export function failingSelector(errorText: string | undefined): string | undefined {
  if (errorText === undefined) return undefined;

  // `waiting for locator('[data-test="x"]')` — the common wait failure.
  const waiting = /waiting for (?:locator|selector)\((['"`])([\s\S]*?)\1\)/.exec(errorText);
  if (waiting !== null) return waiting[2];

  // `Locator: locator('#a')` — the expect() failure block.
  const expectBlock = /Locator:\s*locator\((['"`])([\s\S]*?)\1\)/.exec(errorText);
  if (expectBlock !== null) return expectBlock[2];

  // `strict mode violation: getByRole('button') resolved to 3 elements`
  const strict = /strict mode violation:\s*(.+?)\s+resolved to/.exec(errorText);
  if (strict !== null) return strict[1];

  return undefined;
}

export interface RetryCandidate {
  element: Element;
  /** The candidate that just failed, when it could be identified. */
  previous?: SelectorCandidate;
  next: SelectorCandidate;
  /** The Playwright expression to write in place of the old one. */
  expression: string;
}

/**
 * Choose the next selector to try for a failing element.
 *
 * Only verified-unique candidates are eligible — the same rule the Emitter
 * follows, for the same reason. Candidates are considered in the LOCKED ranked
 * order, and anything already tried is skipped, so a loop cannot propose the
 * selector that just failed.
 */
export function nextSelector(
  element: Element,
  alreadyTried: readonly string[],
): RetryCandidate | undefined {
  const tried = new Set(alreadyTried);
  const usable = sortCandidates(element.selectorCandidates).filter((c) => c.verified && c.unique);

  // The *most recently* tried candidate is the one currently in the file. Taking
  // the first-in-ranked-order instead makes the second iteration try to replace
  // an expression the first iteration already replaced, and the swap silently
  // fails to match.
  const previous = [...alreadyTried]
    .reverse()
    .map((value) => usable.find((c) => c.value === value))
    .find((c): c is SelectorCandidate => c !== undefined);
  const next = usable.find((c) => !tried.has(c.value));
  if (next === undefined) return undefined;

  return {
    element,
    ...(previous !== undefined ? { previous } : {}),
    next,
    expression: locatorExpression({
      strategy: next.strategy,
      value: next.value,
      score: next.score,
      elementId: element.id,
      description: element.name === '' ? element.role : `${element.role} "${element.name}"`,
    }),
  };
}

/**
 * Find the element a failing selector belongs to.
 *
 * Matches on the candidate *value*, which is what appears in the error, rather
 * than on the emitted expression — `getByRole('button', { name: 'Login' })` in
 * the code is stored as `button[name="Login"]` in the model, and only the
 * former shows up in Playwright's output. Both encodings are checked.
 */
export function elementForSelector(model: ScreenModel, selector: string): Element | undefined {
  const needle = selector.trim();
  if (needle === '') return undefined;

  for (const page of model.pages) {
    for (const element of page.elements) {
      for (const candidate of element.selectorCandidates) {
        if (candidate.value === needle) return element;
        // The role encoding: the error shows the rendered getByRole call.
        const rendered = locatorExpression(
          {
            strategy: candidate.strategy,
            value: candidate.value,
            score: candidate.score,
            elementId: element.id,
            description: '',
          },
          'page',
        );
        if (rendered.includes(needle)) return element;
      }
    }
  }
  return undefined;
}

export interface SelectorSwap {
  /** The line as it appears now. */
  from: string;
  /** What to replace it with. */
  to: string;
}

/**
 * Rewrite a page object's locator line to use the next candidate.
 *
 * Returns undefined when the old expression is not in the source — which means
 * the page object is not what we think it is, and a blind edit would corrupt
 * it. Refusing is the correct outcome; the LLM repair path can look at it with
 * the full file in hand.
 */
export function swapSelector(
  source: string,
  oldExpression: string,
  newExpression: string,
): SelectorSwap | undefined {
  if (!source.includes(oldExpression)) return undefined;
  if (oldExpression === newExpression) return undefined;
  return { from: oldExpression, to: newExpression };
}

/** Apply a swap. Every occurrence, because a locator is assigned exactly once. */
export function applySwap(source: string, swap: SelectorSwap): string {
  return source.split(swap.from).join(swap.to);
}
