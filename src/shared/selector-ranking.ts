/**
 * Selector ranking rules — LOCKED (master plan B4).
 *
 * These scores are the deterministic contract used by the Explorer's
 * selector-ranker (Phase 1) and the Emitter's candidate picker (Phase 4).
 * They are defined here as exported constants so both stages share one source
 * of truth. Do not change these values without human approval.
 *
 *   testid                              100
 *   role + accessible-name (if unique)   85
 *   label                                75
 *   placeholder                          65
 *   exact text (if unique)               55
 *   scoped css                           30
 *
 * Uniqueness is verified live during exploration (`locator.count() === 1`).
 * Non-unique candidates are multiplied by 0.3 and marked `unique: false`.
 */

/** The ordered set of selector strategies, strongest first. */
export const SELECTOR_STRATEGIES = [
  'testid',
  'role',
  'label',
  'placeholder',
  'text',
  'css',
] as const;

export type SelectorStrategy = (typeof SELECTOR_STRATEGIES)[number];

/** Base score per strategy when the candidate resolves to a unique element. */
export const SELECTOR_STRATEGY_SCORES: Readonly<Record<SelectorStrategy, number>> = Object.freeze({
  testid: 100,
  role: 85,
  label: 75,
  placeholder: 65,
  text: 55,
  css: 30,
});

/** Multiplier applied to a candidate's base score when it is NOT unique. */
export const NON_UNIQUE_SCORE_MULTIPLIER = 0.3;

/**
 * Compute the deterministic score for a selector candidate.
 *
 * Pure function — same inputs always produce the same score. Table-driven
 * tests cover every strategy in both unique and non-unique states.
 */
export function scoreSelector(strategy: SelectorStrategy, unique: boolean): number {
  const base = SELECTOR_STRATEGY_SCORES[strategy];
  return unique ? base : base * NON_UNIQUE_SCORE_MULTIPLIER;
}
