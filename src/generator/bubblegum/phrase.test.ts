import { describe, it, expect } from 'vitest';
import type { Element } from '../../schemas/screen-model.js';
import type { PlanStep } from '../../schemas/test-plan.js';
import { addressableName, phraseFor, type Phrase } from './phrase.js';

/**
 * Table-driven, because this is a pure function and the whole dialect rests on
 * it: a sentence naming a control that does not exist is valid TypeScript that
 * compiles, imports nothing wrong, and fails in CI as a resolver timeout.
 */

const element = (over: Partial<Element> = {}): Element => ({
  id: 'el-signin',
  role: 'button',
  name: 'Sign In',
  tagName: 'button',
  boundingBox: { x: 0, y: 0, width: 10, height: 10 },
  states: { visible: true, enabled: true },
  selectorCandidates: [],
  ...over,
});

const step = (over: Partial<PlanStep>): PlanStep =>
  ({ action: 'click', elementRef: 'el-signin', ...over }) as PlanStep;

const text = (phrase: Phrase): string =>
  'text' in phrase ? phrase.text : `<${phrase.kind}>`;

describe('driving the page', () => {
  // The forms match the phrases already in the target suite's own flows, read
  // out of the manifest. Inventing a second house style would leave two
  // dialects side by side in one repository forever.
  const cases: Array<[string, PlanStep, Partial<Element>, string]> = [
    [
      'click names the control the way the suite does',
      step({ action: 'click' }),
      {},
      'Click the Sign In button',
    ],
    [
      'fill quotes the value and names the field',
      step({ action: 'fill', value: 'standard_user', elementRef: 'el-user' }),
      { id: 'el-user', role: 'textbox', name: 'Username' },
      'Enter "standard_user" into Username',
    ],
    [
      'select says from, not into',
      step({ action: 'select', value: 'Price (low to high)', elementRef: 'el-sort' }),
      { id: 'el-sort', role: 'combobox', name: 'Sort by' },
      'Select "Price (low to high)" from Sort by dropdown',
    ],
  ];

  for (const [name, planStep, over, expected] of cases) {
    it(name, () => {
      const phrase = phraseFor({ step: planStep, element: element(over) });
      expect(phrase.kind).toBe('act');
      expect(text(phrase)).toBe(expected);
    });
  }
});

describe('asserting', () => {
  const cases: Array<[string, PlanStep['assertion'], string]> = [
    ['visible', { kind: 'visible', expected: true }, 'the "Sign In" button is present'],
    // "is not visible" rather than "is hidden": removed from the DOM and styled
    // out both satisfy the requirement; the other wording claims something
    // about CSS.
    ['hidden', { kind: 'hidden', expected: true }, 'the "Sign In" button is not present'],
    ['text', { kind: 'text', expected: 'Swag Labs' }, 'the "Sign In" button is "Swag Labs"'],
    ['value', { kind: 'value', expected: 'abc' }, 'the "Sign In" button contains "abc"'],
    ['count', { kind: 'count', expected: 6 }, 'there are 6 "Sign In"'],
    ['toast', { kind: 'toast', expected: 'Saved' }, 'a message saying "Saved" is present'],
  ];

  for (const [name, assertion, expected] of cases) {
    it(`renders a ${name} assertion`, () => {
      const phrase = phraseFor({ step: step({ action: 'assert', assertion }), element: element() });
      expect(phrase.kind).toBe('verify');
      expect(text(phrase)).toBe(expected);
    });
  }
});

describe('what stays exact', () => {
  // Anything checkable exactly should not go through a natural-language
  // resolver: that trades a deterministic assertion for a probabilistic one and
  // pays per token for the downgrade.
  it('emits goto natively', () => {
    const phrase = phraseFor({ step: step({ action: 'goto', value: 'https://x.test/' }) });
    expect(phrase).toEqual({ kind: 'goto', url: 'https://x.test/' });
  });

  it('falls back to baseUrl for a goto with no value', () => {
    const phrase = phraseFor({ step: step({ action: 'goto' }), baseUrl: 'https://x.test/' });
    expect(phrase).toEqual({ kind: 'goto', url: 'https://x.test/' });
  });

  it('emits a url assertion natively, not as a sentence', () => {
    const phrase = phraseFor({
      step: step({ action: 'assert', assertion: { kind: 'url', expected: '/inventory.html' } }),
      element: element(),
    });
    expect(phrase).toEqual({ kind: 'url', expected: '/inventory.html' });
  });
});

describe('a dialog is the one thing a sentence has to say', () => {
  // On an ordinary page "Click Save" is the whole step. With a modal open there
  // are two Save buttons, and a person writing the step by hand would say which.
  it('qualifies an element inside a dialog', () => {
    const phrase = phraseFor({
      step: step({ action: 'click' }),
      element: element({ name: 'Save', inDialog: true }),
    });
    expect(text(phrase)).toBe('Click the Save button in dialog');
  });

  it('says nothing extra for an element on the page', () => {
    const phrase = phraseFor({ step: step({ action: 'click' }), element: element({ name: 'Save' }) });
    expect(text(phrase)).toBe('Click the Save button');
  });

  it('qualifies an assertion too', () => {
    const phrase = phraseFor({
      step: step({ action: 'assert', assertion: { kind: 'visible', expected: true } }),
      element: element({ name: 'Save', inDialog: true }),
    });
    expect(text(phrase)).toBe('the "Save" button is present in dialog');
  });
});

describe('ground before you generate, moved to labels', () => {
  it('refuses a step whose element is not in the Screen Model', () => {
    const phrase = phraseFor({ step: step({ elementRef: 'el-ghost' }) });
    expect(phrase.kind).toBe('ungrounded');
    expect(phrase).toMatchObject({ reason: expect.stringContaining('el-ghost') });
  });

  it('refuses an element with nothing to call it by', () => {
    // An icon button with no label cannot be named in a sentence. Emitting one
    // anyway resolves to whatever happens to be nearby.
    const phrase = phraseFor({
      step: step({}),
      element: element({ name: '', text: undefined, testId: undefined }),
    });
    expect(phrase.kind).toBe('ungrounded');
    expect(phrase).toMatchObject({ reason: expect.stringContaining('nothing to call it by') });
  });

  it('refuses an action step that names no element at all', () => {
    const phrase = phraseFor({ step: { action: 'click' } });
    expect(phrase.kind).toBe('ungrounded');
  });
});

describe('addressableName', () => {
  it('prefers the accessible name', () => {
    expect(addressableName(element({ name: 'Sign In', text: 'SIGN IN NOW' }))).toBe('Sign In');
  });

  it('falls back to visible text', () => {
    expect(addressableName(element({ name: '', text: 'Continue' }))).toBe('Continue');
  });

  it('falls back to a test id, reluctantly', () => {
    // `submit-btn` is not English, but it is deterministic and present, which
    // beats refusing to emit a step for a control the authors deliberately
    // marked.
    expect(addressableName(element({ name: '', text: undefined, testId: 'submit-btn' }))).toBe(
      'submit-btn',
    );
  });

  it('skips text that is a paragraph rather than a label', () => {
    const prose = 'Sauce Labs Backpack — carry.allTheThings() with the sleek, streamlined bag';
    expect(addressableName(element({ name: '', text: prose, testId: 'item-title' }))).toBe(
      'item-title',
    );
  });

  it('returns nothing when there is nothing', () => {
    expect(addressableName(element({ name: '', text: undefined, testId: undefined }))).toBeUndefined();
  });
});
