import type { Page, ScreenModel } from '../schemas/screen-model.js';
import type { FeatureSpec } from './feature-spec.js';

/**
 * Choosing which Screen Model pages a feature spec is about.
 *
 * This decides what the planner can see, and therefore what it can plan. Too
 * few pages and it emits `blocked` cases for UI that exists; too many and the
 * real pages get truncated out by the token budget.
 *
 * Three signals, strongest first:
 *   1. explicit `pages:` frontmatter hints (a human said so)
 *   2. explicit `flows:` hints, matched against how a page was reached
 *   3. keyword overlap between the spec and the page's title/url/elements
 *
 * Deterministic throughout — same spec and model produce the same ordering, so
 * the prompt is stable and Phase 4's byte-identical regeneration holds.
 */

export interface PageMatch {
  page: Page;
  score: number;
  /** Why this page was chosen, surfaced in the rendered plan for review. */
  reason: 'pages-hint' | 'flow-hint' | 'keyword' | 'only-page';
}

/** Weights are relative only; the ordering they produce is what matters. */
const HINT_SCORE = 1000;
const FLOW_SCORE = 800;
const KEYWORD_SCORE = 10;

/** Words too common to carry signal when matching a spec to a page. */
const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'of',
  'to',
  'in',
  'on',
  'for',
  'with',
  'user',
  'users',
  'can',
  'should',
  'test',
  'tests',
  'page',
  'pages',
  'when',
  'then',
  'given',
  'it',
  'is',
  'are',
  'be',
  'as',
  'at',
  'by',
  'from',
  'that',
  'this',
  'their',
  'they',
  'must',
  'will',
]);

export interface MatchOptions {
  /** Cap on pages returned; the context builder trims further if needed. */
  limit?: number;
}

const DEFAULT_LIMIT = 8;

/**
 * Rank the model's pages by relevance to a spec.
 *
 * Returns only pages with some positive signal, except in the degenerate case
 * where nothing matches at all — then the whole (small) model is returned, on
 * the grounds that a planner with the wrong pages can emit `blocked`, while a
 * planner with no pages can only fail.
 */
export function matchPages(
  spec: FeatureSpec,
  model: ScreenModel,
  options: MatchOptions = {},
): PageMatch[] {
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (model.pages.length === 0) return [];

  const hints = (spec.frontmatter.pages ?? []).map((h) => h.toLowerCase());
  const flows = new Set(spec.frontmatter.flows ?? []);
  const keywords = specKeywords(spec);

  const scored: PageMatch[] = [];
  for (const page of model.pages) {
    let score = 0;
    let reason: PageMatch['reason'] = 'keyword';

    if (hints.some((hint) => matchesHint(page, hint))) {
      score += HINT_SCORE;
      reason = 'pages-hint';
    }
    if (page.reachedVia.kind === 'flow' && flows.has(page.reachedVia.flowId)) {
      score += FLOW_SCORE;
      if (reason !== 'pages-hint') reason = 'flow-hint';
    }
    const overlap = keywordOverlap(page, keywords);
    score += overlap * KEYWORD_SCORE;

    if (score > 0) scored.push({ page, score, reason });
  }

  if (scored.length === 0) {
    // Nothing matched. Hand over everything rather than nothing — see above.
    return model.pages
      .slice(0, limit)
      .map((page) => ({ page, score: 0, reason: 'only-page' as const }));
  }

  return (
    scored
      // Ties break on page id so the prompt is byte-stable across runs.
      .sort((a, b) =>
        b.score !== a.score ? b.score - a.score : a.page.id.localeCompare(b.page.id),
      )
      .slice(0, limit)
  );
}

/**
 * Does a `pages:` hint select this page?
 *
 * Exact match on the normalized path first, then substring against path, URL
 * or title. The substring branch is skipped for a bare `/` — every path
 * contains a slash, so `pages: ['/']` would select the entire model while
 * still reporting `pages-hint`, making a useless hint indistinguishable from a
 * precise one. `/` is a legitimate hint for a root-page app (saucedemo's login
 * screen is at `/`), so it must mean *only* the root.
 */
function matchesHint(page: Page, hint: string): boolean {
  if (hint === '') return false;
  const wanted = normalizeForHint(hint);
  const pattern = normalizeForHint(page.urlPattern.toLowerCase());
  if (pattern === wanted) return true;
  if (wanted === '/') return false;
  return (
    pattern.includes(wanted) ||
    page.url.toLowerCase().includes(wanted) ||
    page.title.toLowerCase().includes(wanted)
  );
}

/** Trailing slashes are not identity; the root stays `/`. */
function normalizeForHint(value: string): string {
  const trimmed = value.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/** Content words from the spec's title, body and acceptance criteria. */
export function specKeywords(spec: FeatureSpec): Set<string> {
  const { title, acceptanceCriteria, negativeCases } = spec.frontmatter;
  const text = [title, spec.body, ...(acceptanceCriteria ?? []), ...(negativeCases ?? [])].join(
    ' ',
  );
  return new Set(tokenize(text));
}

function keywordOverlap(page: Page, keywords: Set<string>): number {
  const pageWords = new Set([
    ...tokenize(page.title),
    ...tokenize(page.urlPattern.replace(/[/\-_.]/g, ' ')),
    ...page.elements.flatMap((e) => [...tokenize(e.name), ...tokenize(e.testId ?? '')]),
  ]);
  let hits = 0;
  for (const word of pageWords) if (keywords.has(word)) hits += 1;
  return hits;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
}
