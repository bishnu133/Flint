import type { Element } from '../../schemas/screen-model.js';
import type { PlanStep } from '../../schemas/test-plan.js';

/**
 * A plan step, said out loud (Bubblegum B3).
 *
 * Bubblegum takes a sentence instead of a selector: `act(engine, 'Click Sign
 * In')`, and the engine resolves it against the live page at run time. So the
 * emitter's job in this dialect is not to choose a locator — it is to write a
 * sentence that names one thing unambiguously.
 *
 * ## Ground before you generate, moved
 *
 * The core rule does not disappear here, it changes target. In `playwright-pom`
 * the model may not invent a **selector**; here it may not invent an **element
 * label**, because a sentence naming a control that does not exist is valid
 * TypeScript that compiles, imports nothing wrong, and fails at run time with a
 * resolver timeout. Every phrase below is built from an `Element` the explorer
 * actually captured, or it is refused.
 *
 * ## The house style is observed, not invented
 *
 * The forms here match the phrases already in the target suite's own flows,
 * read out of the manifest:
 *
 *     Enter "${credentials.username}" into Username
 *     Click Sign In
 *
 * A generator that wrote `Type the username into the Username field` would be
 * producing correct English in a second dialect, sitting beside the first in
 * the same repository forever.
 *
 * ## What does not become a sentence
 *
 * Anything checkable exactly stays exact. A URL is a string comparison, and
 * routing it through a natural-language resolver would trade a deterministic
 * assertion for a probabilistic one and pay for the privilege. `goto` and `url`
 * are emitted as native Playwright, and only element-level work becomes prose.
 */

export type Phrase =
  /** `await act(engine, page, text)` — drives the page. */
  | { kind: 'act'; text: string; elementId: string }
  /** `await verify(engine, page, text)` — asserts in natural language. */
  | { kind: 'verify'; text: string; elementId?: string }
  /** `await page.goto(url)` — exact, no resolver involved. */
  | { kind: 'goto'; url: string }
  /** `await expect(page).toHaveURL(...)` — exact, no resolver involved. */
  | { kind: 'url'; expected: string }
  /** A free-text step the plan could not express. Emitted as a TODO comment. */
  | { kind: 'note'; text: string }
  /**
   * Refused. The step names an element the Screen Model does not have, or one
   * with nothing readable to call it by. Never emitted as code — the emitter
   * turns these into a blocked test, so the failure is visible at generation
   * time rather than as a resolver timeout in CI.
   */
  | { kind: 'ungrounded'; reason: string };

export interface PhraseInput {
  step: PlanStep;
  /** The element `step.elementRef` resolved to, if it resolved at all. */
  element?: Element;
  /** For `goto` steps with no explicit value. */
  baseUrl?: string;
}

export function phraseFor(input: PhraseInput): Phrase {
  const { step, element } = input;

  if (step.action === 'goto') {
    const url = step.value ?? input.baseUrl;
    return url === undefined
      ? { kind: 'ungrounded', reason: 'a goto step with no url and no baseUrl to fall back on' }
      : { kind: 'goto', url };
  }

  // A URL assertion is a string comparison. Sending it to a resolver would make
  // a certain check uncertain and bill for it.
  if (step.action === 'assert' && step.assertion?.kind === 'url') {
    return { kind: 'url', expected: String(step.assertion.expected) };
  }

  if (step.action === 'custom') {
    return { kind: 'note', text: step.note ?? 'custom step with no note' };
  }

  if (step.elementRef === undefined) {
    return {
      kind: 'ungrounded',
      reason: `a ${step.action} step naming no element`,
    };
  }
  if (element === undefined) {
    // The referential check should have caught this upstream. Refusing again
    // here is cheap, and the alternative is a sentence built from an id.
    return {
      kind: 'ungrounded',
      reason: `element \`${step.elementRef}\` is not in the Screen Model`,
    };
  }

  const name = addressableName(element);
  if (name === undefined) {
    return {
      kind: 'ungrounded',
      reason:
        `element \`${element.id}\` (${element.role}) has no accessible name, text or test id — ` +
        'there is nothing to call it by in a sentence',
    };
  }

  const where = element.inDialog === true ? ' in dialog' : '';

  switch (step.action) {
    case 'click':
      return { kind: 'act', text: `Click ${name}${where}`, elementId: element.id };
    case 'fill':
      return {
        kind: 'act',
        text: `Enter "${step.value ?? ''}" into ${name}${where}`,
        elementId: element.id,
      };
    case 'select':
      return {
        kind: 'act',
        text: `Select "${step.value ?? ''}" from ${name}${where}`,
        elementId: element.id,
      };
    case 'assert':
      return assertPhrase(step, name, where, element.id);
  }
}

function assertPhrase(
  step: PlanStep,
  name: string,
  where: string,
  elementId: string,
): Phrase {
  const assertion = step.assertion;
  if (assertion === undefined) {
    return { kind: 'ungrounded', reason: 'an assert step with no assertion' };
  }
  const expected = String(assertion.expected);

  switch (assertion.kind) {
    case 'visible':
      return { kind: 'verify', text: `${name} is visible${where}`, elementId };
    case 'hidden':
      // "is not visible" rather than "is hidden": a control removed from the DOM
      // and one styled out both satisfy the requirement, and the second wording
      // reads as a claim about CSS.
      return { kind: 'verify', text: `${name} is not visible${where}`, elementId };
    case 'text':
      return { kind: 'verify', text: `${name} shows "${expected}"${where}`, elementId };
    case 'value':
      return { kind: 'verify', text: `${name} contains "${expected}"${where}`, elementId };
    case 'count':
      return { kind: 'verify', text: `There are ${expected} ${name}${where}`, elementId };
    case 'toast':
      return { kind: 'verify', text: `A message saying "${expected}" is visible`, elementId };
    case 'url':
      // Handled before this function; kept exhaustive so a new assertion kind
      // fails to compile rather than falling through to a wrong sentence.
      return { kind: 'url', expected };
  }
}

/**
 * What to call this element in a sentence.
 *
 * Accessible name first, because it is what a person reading the screen would
 * say and what the resolver is matching against. Visible text second. A test id
 * last and reluctantly — `submit-btn` is not English, but it is deterministic
 * and present, which beats refusing to emit a step for a control the suite's own
 * authors deliberately marked.
 *
 * Returning nothing is a real answer. An icon button with no label cannot be
 * named in a sentence, and this dialect should say so rather than emit a phrase
 * that resolves to whatever happens to be nearby.
 */
export function addressableName(element: Element): string | undefined {
  const candidates = [element.name, element.text, element.testId];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    // Long visible text is a paragraph, not a name — it makes an unreadable
    // sentence and a worse resolver query than the next candidate.
    if (trimmed !== undefined && trimmed !== '' && trimmed.length <= MAX_NAME_LENGTH) {
      return trimmed;
    }
  }
  return undefined;
}

/** Beyond this an element's text is prose rather than a label. */
const MAX_NAME_LENGTH = 60;
