import type { TestCase, TestPlan } from '../schemas/test-plan.js';
import type { SuiteIndex } from '../schemas/suite-index.js';

/**
 * Deterministic post-checks on a generated plan.
 *
 * The LLM produced the plan; these decide whether it is allowed to stand. Both
 * checks are pure functions of the plan plus the two artefacts it was built
 * from, so neither depends on the model behaving well.
 *
 * 1. **Referential integrity.** Every `elementRef` must be an Element.id the
 *    context actually offered. This is core principle #1 mechanised: the model
 *    cannot invent a selector because it never writes selectors, only ids, and
 *    an id it made up fails here.
 *
 * 2. **Duplicate detection.** The planner is asked to consult the coverage map,
 *    but "asked to" is not a guarantee. A deterministic pass re-checks title
 *    similarity against existing tests and forces `skipped-duplicate`.
 */

export interface UnknownElementRef {
  caseId: string;
  stepIndex: number;
  elementRef: string;
}

export interface ReferentialReport {
  ok: boolean;
  unknown: UnknownElementRef[];
}

/**
 * Check every `elementRef` against the ids the planner was shown.
 *
 * `blocked` cases are exempt: a blocked case exists precisely because the UI is
 * missing, and its steps may reference what the spec asked for rather than what
 * exists. That is the case doing its job, not a violation.
 */
export function checkElementRefs(
  plan: TestPlan,
  allowedElementIds: Set<string>,
): ReferentialReport {
  const unknown: UnknownElementRef[] = [];
  for (const testCase of plan.cases) {
    if (testCase.status === 'blocked') continue;
    testCase.steps.forEach((step, stepIndex) => {
      if (step.elementRef === undefined) return;
      if (allowedElementIds.has(step.elementRef)) return;
      unknown.push({ caseId: testCase.id, stepIndex, elementRef: step.elementRef });
    });
  }
  return { ok: unknown.length === 0, unknown };
}

/** Human-readable failure, naming every offending reference. */
export function formatReferentialReport(report: ReferentialReport): string {
  if (report.ok) return 'All element references resolve to real Screen Model elements.';
  const lines = [
    `${report.unknown.length} plan step(s) reference elements that do not exist in the Screen Model:`,
    '',
  ];
  for (const bad of report.unknown) {
    lines.push(`  case ${bad.caseId}, step ${bad.stepIndex + 1}: ${bad.elementRef}`);
  }
  lines.push(
    '',
    'The planner may only reference element ids it was shown. Re-run `flint explore`',
    'if the app has changed, or add a flow script to reach the missing state.',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

export interface DuplicateDecision {
  caseId: string;
  /** The existing test title this duplicates. */
  duplicateOf: string;
  similarity: number;
}

export interface DuplicateReport {
  plan: TestPlan;
  forced: DuplicateDecision[];
}

/**
 * Similarity above which two titles are considered the same behaviour.
 *
 * Tuned to catch rewording ("User can sign in" vs "User signs in") without
 * collapsing genuinely different cases ("User can sign in" vs "User cannot sign
 * in with a bad password" — which share most words but differ in the tokens
 * that matter). The negation guard below handles that second pair.
 */
const SIMILARITY_THRESHOLD = 0.8;

/** Tokens whose presence on one side only means the cases are NOT the same. */
const NEGATION_TOKENS = new Set([
  'not',
  'cannot',
  'without',
  'invalid',
  'wrong',
  'fails',
  'fail',
  'failed',
  'error',
  'missing',
  'denied',
  'rejected',
  'empty',
  'locked',
]);

/**
 * Force `skipped-duplicate` on cases the suite already covers.
 *
 * Only considers tests already tagged with this feature id. A similar title
 * under a *different* feature is usually a genuinely different behaviour that
 * happens to read alike, and silently skipping it would lose coverage — the
 * expensive direction of this error.
 */
export function applyDuplicateDetection(plan: TestPlan, index: SuiteIndex): DuplicateReport {
  const existing = index.coverageMap[plan.featureId] ?? [];
  if (existing.length === 0) return { plan, forced: [] };

  const forced: DuplicateDecision[] = [];
  const cases = plan.cases.map((testCase): TestCase => {
    // Never override a decision the planner already made explicitly.
    if (testCase.status !== 'new') return testCase;

    const best = bestMatch(testCase.title, existing);
    if (best === undefined || best.similarity < SIMILARITY_THRESHOLD) return testCase;

    forced.push({ caseId: testCase.id, duplicateOf: best.title, similarity: best.similarity });
    return {
      ...testCase,
      status: 'skipped-duplicate',
      duplicateOf: best.title,
    };
  });

  return { plan: { ...plan, cases }, forced };
}

function bestMatch(
  title: string,
  candidates: string[],
): { title: string; similarity: number } | undefined {
  let best: { title: string; similarity: number } | undefined;
  for (const candidate of candidates) {
    const similarity = titleSimilarity(title, candidate);
    if (best === undefined || similarity > best.similarity) best = { title: candidate, similarity };
  }
  return best;
}

/**
 * Jaccard similarity over content words, with a negation guard.
 *
 * "User can log in" and "User cannot log in" overlap heavily by word count but
 * test opposite behaviours; treating them as duplicates would silently drop the
 * negative case. If one side carries a negation token and the other does not,
 * they are not the same test.
 */
export function titleSimilarity(a: string, b: string): number {
  const wordsA = tokenize(a);
  const wordsB = tokenize(b);
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  const negatedA = [...wordsA].some((w) => NEGATION_TOKENS.has(w));
  const negatedB = [...wordsB].some((w) => NEGATION_TOKENS.has(w));
  if (negatedA !== negatedB) return 0;

  let shared = 0;
  for (const word of wordsA) if (wordsB.has(word)) shared += 1;
  const union = wordsA.size + wordsB.size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * Words that carry no behavioural signal in a test title. Without this,
 * "User can sign in" and "User signs in" score far apart on shared words alone
 * despite describing the same test.
 */
const TITLE_STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'of',
  'to',
  'in',
  'on',
  'at',
  'for',
  'with',
  'from',
  'by',
  'as',
  'is',
  'are',
  'be',
  'can',
  'will',
  'should',
  'must',
  'when',
  'then',
  'given',
  'it',
  'that',
  'this',
  'their',
  'they',
  'user',
  'users',
  'successfully',
  'correctly',
]);

function tokenize(text: string): Set<string> {
  const words = text
    .toLowerCase()
    // Strip tags — "@flint @feature:auth-1" is not part of the behaviour.
    .replace(/@[\w:.\-/]+/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1);

  const out = new Set<string>();
  for (const word of words) {
    // Negations are load-bearing, so they survive stop-word removal.
    if (NEGATION_TOKENS.has(word)) {
      out.add(word);
      continue;
    }
    if (TITLE_STOP_WORDS.has(word)) continue;
    out.add(stem(word));
  }
  return out;
}

/**
 * Crude plural/tense stripping — enough to match "signs"/"sign" and
 * "removes"/"remove" without a stemmer dependency. Over-stemming a rare word
 * costs nothing here: both sides go through the same function.
 */
function stem(word: string): string {
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}
