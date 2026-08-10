import { describe, it, expect } from 'vitest';
import {
  buildCandidates,
  scoreCandidate,
  applyVerification,
  sortCandidates,
  pickBest,
  I18N_TEXT_DEMOTION,
  type ElementFacts,
} from './selector-ranker.js';
import type { SelectorStrategy } from '../shared/selector-ranking.js';
import type { SelectorCandidate } from '../schemas/screen-model.js';

const fullFacts: ElementFacts = {
  testId: 'login-btn',
  role: 'button',
  name: 'Log in',
  label: 'Log in',
  placeholder: 'Enter email',
  text: 'Log in',
  css: 'form > button.primary',
};

function candidate(
  strategy: SelectorStrategy,
  value: string,
  score: number,
  opts: { unique?: boolean; verified?: boolean } = {},
): SelectorCandidate {
  return {
    strategy,
    value,
    score,
    unique: opts.unique ?? true,
    verified: opts.verified ?? true,
  };
}

describe('buildCandidates', () => {
  it('emits every applicable strategy, strongest first', () => {
    const result = buildCandidates(fullFacts);
    expect(result.map((c) => c.strategy)).toEqual([
      'testid',
      'role',
      'label',
      'placeholder',
      'text',
      'css',
    ]);
  });

  it('honours a custom test-id attribute', () => {
    const result = buildCandidates(fullFacts, { testIdAttribute: 'data-qa' });
    expect(result[0]?.value).toBe('[data-qa="login-btn"]');
  });

  it('omits a role candidate when there is no accessible name to match on', () => {
    const result = buildCandidates({ role: 'button', css: 'button' });
    expect(result.map((c) => c.strategy)).toEqual(['css']);
  });

  it('omits empty and whitespace-only values', () => {
    const result = buildCandidates({ text: '   ', label: '', css: 'div' });
    expect(result.map((c) => c.strategy)).toEqual(['css']);
  });

  it('always yields at least the css fallback', () => {
    expect(buildCandidates({ css: 'div:nth-child(2)' })).toHaveLength(1);
  });

  it('marks fresh candidates unverified — the extractor must confirm them', () => {
    expect(buildCandidates(fullFacts).every((c) => c.verified === false)).toBe(true);
  });
});

describe('scoreCandidate', () => {
  // Table-driven across every strategy × unique × i18n combination.
  const cases: Array<{
    strategy: SelectorStrategy;
    unique: boolean;
    i18n: boolean;
    expected: number;
  }> = [
    { strategy: 'testid', unique: true, i18n: false, expected: 100 },
    { strategy: 'testid', unique: false, i18n: false, expected: 30 },
    { strategy: 'testid', unique: true, i18n: true, expected: 100 }, // not text-derived
    { strategy: 'role', unique: true, i18n: false, expected: 85 },
    { strategy: 'role', unique: true, i18n: true, expected: 42.5 },
    { strategy: 'role', unique: false, i18n: true, expected: 12.75 },
    { strategy: 'label', unique: true, i18n: false, expected: 75 },
    { strategy: 'label', unique: true, i18n: true, expected: 37.5 },
    { strategy: 'placeholder', unique: true, i18n: false, expected: 65 },
    { strategy: 'placeholder', unique: true, i18n: true, expected: 32.5 },
    { strategy: 'text', unique: true, i18n: false, expected: 55 },
    { strategy: 'text', unique: true, i18n: true, expected: 27.5 },
    { strategy: 'css', unique: true, i18n: false, expected: 30 },
    { strategy: 'css', unique: true, i18n: true, expected: 30 }, // not text-derived
    { strategy: 'css', unique: false, i18n: true, expected: 9 },
  ];

  for (const { strategy, unique, i18n, expected } of cases) {
    it(`${strategy} unique=${unique} i18n=${i18n} => ${expected}`, () => {
      expect(scoreCandidate(strategy, unique, { i18n })).toBeCloseTo(expected, 10);
    });
  }

  it('demotes text-derived strategies by exactly the documented factor', () => {
    expect(scoreCandidate('text', true, { i18n: true })).toBeCloseTo(
      scoreCandidate('text', true) * I18N_TEXT_DEMOTION,
      10,
    );
  });

  it('under i18n, a unique testid still outranks a unique role', () => {
    expect(scoreCandidate('testid', true, { i18n: true })).toBeGreaterThan(
      scoreCandidate('role', true, { i18n: true }),
    );
  });

  it('under i18n, css outranks text — the whole point of the demotion', () => {
    expect(scoreCandidate('css', true, { i18n: true })).toBeGreaterThan(
      scoreCandidate('text', true, { i18n: true }),
    );
  });
});

describe('applyVerification', () => {
  it('re-scores down when the candidate turns out non-unique', () => {
    const fresh = buildCandidates(fullFacts)[0]!;
    const verified = applyVerification(fresh, false);
    expect(verified.unique).toBe(false);
    expect(verified.verified).toBe(true);
    expect(verified.score).toBeCloseTo(30, 10); // 100 * 0.3
  });

  it('keeps the full score when unique', () => {
    const fresh = buildCandidates(fullFacts)[0]!;
    expect(applyVerification(fresh, true).score).toBeCloseTo(100, 10);
  });

  it('does not mutate the input', () => {
    const fresh = buildCandidates(fullFacts)[0]!;
    applyVerification(fresh, false);
    expect(fresh.verified).toBe(false);
    expect(fresh.score).toBeCloseTo(100, 10);
  });
});

describe('sortCandidates', () => {
  it('orders by score descending', () => {
    const sorted = sortCandidates([
      candidate('css', 'div', 30),
      candidate('testid', '[data-testid="a"]', 100),
      candidate('text', 'Go', 55),
    ]);
    expect(sorted.map((c) => c.strategy)).toEqual(['testid', 'text', 'css']);
  });

  it('breaks score ties by LOCKED strategy order', () => {
    // A non-unique testid (30) ties a unique css (30); testid wins the tiebreak.
    const sorted = sortCandidates([
      candidate('css', 'div', 30),
      candidate('testid', '[data-testid="a"]', 30, { unique: false }),
    ]);
    expect(sorted[0]?.strategy).toBe('testid');
  });

  it('breaks remaining ties lexicographically, so ordering is deterministic', () => {
    const sorted = sortCandidates([candidate('css', 'div.z', 30), candidate('css', 'div.a', 30)]);
    expect(sorted.map((c) => c.value)).toEqual(['div.a', 'div.z']);
  });

  it('is stable across repeated sorts of a shuffled input', () => {
    const input = [
      candidate('text', 'Go', 55),
      candidate('css', 'div.a', 30),
      candidate('testid', '[data-testid="x"]', 100),
      candidate('css', 'div.b', 30),
    ];
    const first = sortCandidates(input).map((c) => c.value);
    const second = sortCandidates([...input].reverse()).map((c) => c.value);
    expect(second).toEqual(first);
  });

  it('does not mutate the input array', () => {
    const input = [candidate('css', 'div', 30), candidate('testid', '[x]', 100)];
    sortCandidates(input);
    expect(input[0]?.strategy).toBe('css');
  });
});

describe('pickBest', () => {
  it('returns the highest-scored verified unique candidate', () => {
    const best = pickBest([
      candidate('css', 'div', 30),
      candidate('testid', '[data-testid="a"]', 100),
    ]);
    expect(best?.strategy).toBe('testid');
  });

  it('skips a higher-scored candidate that is not unique', () => {
    const best = pickBest([
      candidate('testid', '[data-testid="a"]', 30, { unique: false }),
      candidate('css', 'div.one', 30),
    ]);
    expect(best?.strategy).toBe('css');
  });

  it('skips unverified candidates — Phase 4 may only trust verified selectors', () => {
    const best = pickBest([candidate('testid', '[data-testid="a"]', 100, { verified: false })]);
    expect(best).toBeUndefined();
  });

  it('returns undefined when nothing is both verified and unique (=> test.fixme)', () => {
    const best = pickBest([
      candidate('testid', '[data-testid="a"]', 30, { unique: false }),
      candidate('css', 'div', 9, { unique: false }),
    ]);
    expect(best).toBeUndefined();
  });

  it('returns undefined for an empty candidate list', () => {
    expect(pickBest([])).toBeUndefined();
  });
});
