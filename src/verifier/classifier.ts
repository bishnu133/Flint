import type { FailureClass } from '../schemas/run-report.js';

/**
 * Deterministic failure classification.
 *
 * A pure function from a Playwright error to a `FailureClass`. Everything the
 * repair loop does downstream turns on this answer, so it is deliberately
 * mechanical: no model, no heuristics that drift, a table a human can read and
 * argue with.
 *
 * The classification decides very different treatment:
 *
 * - `selector-not-found` — the test is wrong about the page. Repairable, and
 *   the first attempt is deterministic (try the next verified candidate).
 * - `assertion-mismatch` — the app did something other than expected. This is
 *   the class that might be a **real bug in the application**, so it is never
 *   quietly "repaired" into passing; if it survives repair it is surfaced as a
 *   possible app defect.
 * - `env` — the application is not reachable, or the run never got started.
 *   Repair is meaningless and must not be attempted: patching a test cannot
 *   fix a server that is down.
 * - `timeout` / `navigation` — could be either; repairable but reported.
 * - `unknown` — say so rather than guess. A wrong class sends the repair loop
 *   in a wrong direction and burns its (LOCKED, 2-iteration) budget.
 *
 * Order matters: the first rule that matches wins, so the more specific
 * signatures come first. `env` is checked before `navigation` because
 * `net::ERR_CONNECTION_REFUSED` surfaces *as* a navigation failure while
 * meaning the app is down.
 */

interface Rule {
  failureClass: FailureClass;
  /** Why this rule exists, in the words of the error it matches. */
  because: string;
  match: RegExp;
}

/**
 * Matched in order against the error message + stack.
 *
 * Every pattern here comes from a shape Playwright actually emits. Guessing at
 * error text produces a classifier that looks thorough and matches nothing.
 */
const RULES: readonly Rule[] = [
  // --- env: the app or the runner never got off the ground ----------------
  {
    failureClass: 'env',
    because: 'the browser could not reach the server at all',
    match:
      /net::ERR_(CONNECTION_REFUSED|CONNECTION_RESET|CONNECTION_CLOSED|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|ADDRESS_UNREACHABLE|CONNECTION_TIMED_OUT|SSL_PROTOCOL_ERROR|CERT_[A-Z_]+)/,
  },
  {
    failureClass: 'env',
    because: 'the browser binary is missing — nothing was ever run',
    match: /Executable doesn'?t exist|playwright install|browserType\.launch/i,
  },
  {
    failureClass: 'env',
    because: 'the base URL is unset or malformed, so no request was made',
    match: /Invalid URL|baseURL|ERR_INVALID_URL/i,
  },

  // --- selector-not-found: the test is wrong about the page ---------------
  {
    failureClass: 'selector-not-found',
    because: 'a locator resolved to nothing within its timeout',
    match:
      /waiting for (locator|getBy|selector)|locator resolved to 0 elements|strict mode violation|element is not attached to the DOM/i,
  },
  {
    failureClass: 'selector-not-found',
    because: 'an expectation named a locator that never appeared',
    match: /expect\((locator|received)\)\.(toBeVisible|toBeAttached|toHaveCount)/i,
  },

  // --- navigation ---------------------------------------------------------
  {
    failureClass: 'navigation',
    because: 'the page went somewhere the test did not expect',
    match: /expect\(page\)\.toHaveURL|page\.goto|navigation to ".*" is interrupted|ERR_ABORTED/i,
  },

  // --- assertion-mismatch: possibly a real application defect -------------
  {
    failureClass: 'assertion-mismatch',
    because: 'the app produced a value other than the one asserted',
    match: /expect\(.*\)\.(toHaveText|toHaveValue|toContainText|toHaveAttribute|toBe|toEqual)/i,
  },
  {
    failureClass: 'assertion-mismatch',
    because: 'a generic expect failure with an expected/received pair',
    match: /Expected( string| value| pattern)?:[\s\S]*Received/i,
  },

  // --- timeout: last, because most timeouts are more specific than this ---
  {
    failureClass: 'timeout',
    because: 'the test exceeded its own time budget',
    match: /Test timeout of \d+ms exceeded|Timeout of \d+ms exceeded|exceeded while running/i,
  },
  {
    failureClass: 'timeout',
    because: 'an individual operation timed out',
    match: /Timeout \d+ms exceeded/i,
  },
];

export interface ClassifiedFailure {
  failureClass: FailureClass;
  /** The rule's rationale, or a note that nothing matched. */
  because: string;
}

/**
 * Classify one failure.
 *
 * Takes the whole error text — Playwright puts the decisive part in the message
 * for some failures and in the call log for others, so splitting them loses
 * information.
 */
export function classifyFailure(errorText: string | undefined): ClassifiedFailure {
  const text = (errorText ?? '').trim();
  if (text === '') {
    return {
      failureClass: 'unknown',
      because: 'the run produced no error text to classify',
    };
  }
  for (const rule of RULES) {
    if (rule.match.test(text)) {
      return { failureClass: rule.failureClass, because: rule.because };
    }
  }
  return {
    failureClass: 'unknown',
    because: 'no rule matched this error shape',
  };
}

/**
 * Whether the repair loop may attempt this class at all.
 *
 * `env` never: patching a test cannot start a stopped server, and trying wastes
 * the iteration budget while producing a diff that makes the suite worse.
 * `unknown` never: repair needs to know what it is fixing, and a blind edit to
 * passing-shaped code is how a repair loop corrupts a suite.
 */
export function isRepairable(failureClass: FailureClass): boolean {
  return failureClass !== 'env' && failureClass !== 'unknown';
}

/**
 * Whether a deterministic selector retry should be tried before any LLM call.
 *
 * The master plan requires this ordering: a selector that stopped matching is
 * usually fixed by the next verified candidate from the Screen Model, which is
 * free, instant and cannot invent anything.
 */
export function deservesSelectorRetry(failureClass: FailureClass): boolean {
  return failureClass === 'selector-not-found';
}

/**
 * Whether surviving repair makes this a possible application defect.
 *
 * Only assertion mismatches. A selector that cannot be found means the test is
 * out of date; a value that is wrong means either the test or the app is, and
 * saying so is the point — Flint finding real bugs is a feature, not noise.
 */
export function mayBeAppDefect(failureClass: FailureClass): boolean {
  return failureClass === 'assertion-mismatch';
}
