import {
  SELECTOR_STRATEGY_SCORES,
  NON_UNIQUE_SCORE_MULTIPLIER,
  type SelectorStrategy,
} from '../shared/selector-ranking.js';
import type { SelectorCandidate } from '../schemas/screen-model.js';

/**
 * Deterministic selector-candidate builder and ranker.
 *
 * Pure: given the same element facts it always produces the same ordered
 * candidate list. Uniqueness is NOT decided here — the extractor verifies it
 * live against the page (`locator.count() === 1`) and feeds the result back in.
 * Keeping the scoring pure is what makes it table-testable and what lets Phase 4
 * reason about selector choice without a browser.
 *
 * Scores come from the LOCKED constants in `shared/selector-ranking.ts`.
 */

/** Raw element facts the extractor reads off the page. */
export interface ElementFacts {
  /** value of the configured test-id attribute, if present */
  testId?: string;
  /** ARIA role */
  role?: string;
  /** accessible name */
  name?: string;
  /** associated <label> text */
  label?: string;
  placeholder?: string;
  /** trimmed visible text */
  text?: string;
  /** a scoped CSS path, always available as the last resort */
  css: string;
}

export interface RankOptions {
  /**
   * When true, text-derived strategies are demoted because the app's copy
   * changes per locale (master plan Phase 1, i18n scenario).
   */
  i18n?: boolean;
  /** The attribute used for test ids; affects the emitted selector syntax. */
  testIdAttribute?: string;
}

/** Multiplier applied to text-derived strategies when `i18n` is enabled. */
export const I18N_TEXT_DEMOTION = 0.5;

/**
 * Strategies whose value is user-visible copy, and therefore locale-dependent.
 * `role` is included because role selectors match on the accessible NAME.
 */
const TEXT_DERIVED: ReadonlySet<SelectorStrategy> = new Set<SelectorStrategy>([
  'role',
  'label',
  'placeholder',
  'text',
]);

/** Build the full candidate set for an element, ordered strongest first. */
export function buildCandidates(
  facts: ElementFacts,
  options: RankOptions = {},
): SelectorCandidate[] {
  const testIdAttribute = options.testIdAttribute ?? 'data-testid';
  const candidates: SelectorCandidate[] = [];

  const add = (strategy: SelectorStrategy, value: string | undefined): void => {
    if (value === undefined) return;
    const trimmed = value.trim();
    if (trimmed === '') return;
    candidates.push({
      strategy,
      value: trimmed,
      // Provisional: assumes unique. The extractor re-scores after verifying.
      score: scoreCandidate(strategy, true, options),
      unique: true,
      verified: false,
    });
  };

  add('testid', facts.testId === undefined ? undefined : `[${testIdAttribute}="${facts.testId}"]`);
  // A role selector is only usable when it has an accessible name to match on.
  if (facts.role !== undefined && facts.name !== undefined && facts.name.trim() !== '') {
    add('role', `${facts.role}[name="${facts.name.trim()}"]`);
  }
  add('label', facts.label);
  add('placeholder', facts.placeholder);
  add('text', facts.text);
  add('css', facts.css);

  return sortCandidates(candidates);
}

/**
 * Score one candidate. Applies, in order: the LOCKED base score, the i18n
 * demotion for text-derived strategies, then the non-unique penalty.
 */
export function scoreCandidate(
  strategy: SelectorStrategy,
  unique: boolean,
  options: RankOptions = {},
): number {
  let score: number = SELECTOR_STRATEGY_SCORES[strategy];
  if (options.i18n === true && TEXT_DERIVED.has(strategy)) {
    score *= I18N_TEXT_DEMOTION;
  }
  if (!unique) {
    score *= NON_UNIQUE_SCORE_MULTIPLIER;
  }
  return score;
}

/**
 * Re-score a candidate once the extractor has verified it against the live
 * page. Returns a new object — candidates are treated as immutable.
 */
export function applyVerification(
  candidate: SelectorCandidate,
  unique: boolean,
  options: RankOptions = {},
): SelectorCandidate {
  return {
    ...candidate,
    unique,
    verified: true,
    score: scoreCandidate(candidate.strategy, unique, options),
  };
}

/**
 * Stable, deterministic ordering: score descending, then strategy in LOCKED
 * order, then value lexicographically. The final tiebreak matters — without it
 * two runs over the same page could emit different orderings, breaking the
 * byte-identical-regeneration requirement.
 */
export function sortCandidates(candidates: SelectorCandidate[]): SelectorCandidate[] {
  const strategyRank = (s: SelectorStrategy): number => -SELECTOR_STRATEGY_SCORES[s];
  return [...candidates].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const byStrategy = strategyRank(a.strategy) - strategyRank(b.strategy);
    if (byStrategy !== 0) return byStrategy;
    return a.value.localeCompare(b.value);
  });
}

/**
 * The candidate the Emitter should use: highest-scored candidate that is both
 * verified and unique. Returns undefined when none qualifies — Phase 4 turns
 * that into `test.fixme()` rather than emitting a selector it cannot trust.
 */
export function pickBest(candidates: SelectorCandidate[]): SelectorCandidate | undefined {
  return sortCandidates(candidates).find((c) => c.verified && c.unique);
}
