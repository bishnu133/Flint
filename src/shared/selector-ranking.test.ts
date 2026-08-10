import { describe, it, expect } from 'vitest';
import {
  scoreSelector,
  SELECTOR_STRATEGY_SCORES,
  NON_UNIQUE_SCORE_MULTIPLIER,
  SELECTOR_STRATEGIES,
  type SelectorStrategy,
} from './selector-ranking.js';

describe('selector ranking (LOCKED constants)', () => {
  it('has the exact base scores from master plan B4', () => {
    expect(SELECTOR_STRATEGY_SCORES).toEqual({
      testid: 100,
      role: 85,
      label: 75,
      placeholder: 65,
      text: 55,
      css: 30,
    });
    expect(NON_UNIQUE_SCORE_MULTIPLIER).toBe(0.3);
  });

  // Table-driven: every strategy in both unique and non-unique states.
  const cases: Array<{ strategy: SelectorStrategy; unique: boolean; expected: number }> = [
    { strategy: 'testid', unique: true, expected: 100 },
    { strategy: 'testid', unique: false, expected: 30 },
    { strategy: 'role', unique: true, expected: 85 },
    { strategy: 'role', unique: false, expected: 25.5 },
    { strategy: 'label', unique: true, expected: 75 },
    { strategy: 'label', unique: false, expected: 22.5 },
    { strategy: 'placeholder', unique: true, expected: 65 },
    { strategy: 'placeholder', unique: false, expected: 19.5 },
    { strategy: 'text', unique: true, expected: 55 },
    { strategy: 'text', unique: false, expected: 16.5 },
    { strategy: 'css', unique: true, expected: 30 },
    { strategy: 'css', unique: false, expected: 9 },
  ];

  for (const { strategy, unique, expected } of cases) {
    it(`scores ${strategy} (unique=${unique}) as ${expected}`, () => {
      expect(scoreSelector(strategy, unique)).toBeCloseTo(expected, 10);
    });
  }

  it('ranks strategies strongest-first in the canonical order', () => {
    const ordered = [...SELECTOR_STRATEGIES].map((s) => SELECTOR_STRATEGY_SCORES[s]);
    const sortedDesc = [...ordered].sort((a, b) => b - a);
    expect(ordered).toEqual(sortedDesc);
  });
});
