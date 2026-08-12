import { describe, it, expect } from 'vitest';
import {
  classifyFailure,
  deservesSelectorRetry,
  isRepairable,
  mayBeAppDefect,
} from './classifier.js';
import { FailureClassSchema, type FailureClass } from '../schemas/run-report.js';

/**
 * Table-driven, as CLAUDE.md requires for the pure functions.
 *
 * Every input below is a real Playwright error shape rather than an invented
 * one. A classifier tested against text Playwright never emits looks thorough
 * and matches nothing in production — which is exactly how the repair loop
 * would end up sending every failure down the `unknown` path.
 */

const CASES: ReadonlyArray<[label: string, error: string, expected: FailureClass]> = [
  // --- env ----------------------------------------------------------------
  [
    'connection refused',
    'page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/\nCall log:\n  - navigating to "http://localhost:3000/"',
    'env',
  ],
  ['dns failure', 'page.goto: net::ERR_NAME_NOT_RESOLVED at https://nope.invalid/', 'env'],
  [
    'expired certificate',
    'page.goto: net::ERR_CERT_DATE_INVALID at https://expired.example.com/',
    'env',
  ],
  [
    'browser never installed',
    "browserType.launch: Executable doesn't exist at /ms-playwright/chromium-1234/chrome",
    'env',
  ],
  ['malformed base url', 'page.goto: Invalid URL', 'env'],

  // --- selector-not-found -------------------------------------------------
  [
    'locator never appeared',
    'locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for locator(\'[data-test="add-to-cart"]\')',
    'selector-not-found',
  ],
  [
    'strict mode violation',
    "locator.click: Error: strict mode violation: getByRole('button') resolved to 3 elements",
    'selector-not-found',
  ],
  [
    'element detached mid-action',
    'locator.fill: Error: element is not attached to the DOM',
    'selector-not-found',
  ],
  [
    'toBeVisible on a missing element',
    'Error: expect(locator).toBeVisible() failed\n\nLocator: locator(\'[data-test="error"]\')\nExpected: visible\nReceived: <element(s) not found>',
    'selector-not-found',
  ],

  // --- navigation ---------------------------------------------------------
  [
    'landed on the wrong url',
    'Error: expect(page).toHaveURL(expected)\n\nExpected string: "https://x.test/inventory.html"\nReceived string: "https://x.test/"',
    'navigation',
  ],

  // --- assertion-mismatch -------------------------------------------------
  [
    'wrong text',
    'Error: expect(locator).toHaveText(expected)\n\nExpected string: "Epic sadface: Sorry, this user has been locked out."\nReceived string: "Epic sadface: Username and password do not match"',
    'assertion-mismatch',
  ],
  [
    'wrong input value',
    'Error: expect(locator).toHaveValue(expected)\n\nExpected string: "standard_user"\nReceived string: ""',
    'assertion-mismatch',
  ],
  [
    'bare expected/received pair',
    'Error: assertion failed\n\nExpected: 3\nReceived: 5',
    'assertion-mismatch',
  ],

  // --- timeout ------------------------------------------------------------
  ['whole test timed out', 'Test timeout of 30000ms exceeded.', 'timeout'],

  // --- unknown ------------------------------------------------------------
  ['a panic nobody anticipated', 'Error: something nobody has seen before', 'unknown'],
];

describe('classifyFailure', () => {
  it.each(CASES)('%s => %s', (_label, error, expected) => {
    expect(classifyFailure(error).failureClass).toBe(expected);
  });

  it('says so rather than guessing when there is no error text', () => {
    // Guessing here would send the repair loop after a failure it cannot see.
    expect(classifyFailure(undefined).failureClass).toBe('unknown');
    expect(classifyFailure('').failureClass).toBe('unknown');
    expect(classifyFailure('   ').because).toMatch(/no error text/);
  });

  it('always returns a class the LOCKED schema accepts', () => {
    for (const [, error] of CASES) {
      expect(FailureClassSchema.safeParse(classifyFailure(error).failureClass).success).toBe(true);
    }
  });

  it('explains itself, so a human can argue with the rule', () => {
    const result = classifyFailure('page.goto: net::ERR_CONNECTION_REFUSED at http://x/');
    expect(result.because).toMatch(/could not reach the server/);
  });

  it('is a pure function — same input, same answer', () => {
    const error =
      'locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for locator(#a)';
    expect(classifyFailure(error)).toEqual(classifyFailure(error));
  });

  it('prefers env over navigation when the server is simply down', () => {
    // ERR_CONNECTION_REFUSED arrives *as* a page.goto failure. Classifying it
    // as navigation would send it to the repair loop, which would patch a test
    // to work around a stopped server.
    const downServer = 'page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/';
    expect(classifyFailure(downServer).failureClass).toBe('env');
  });

  it('prefers selector-not-found over timeout for a locator wait', () => {
    // Both patterns appear in the same message. Calling it a timeout would skip
    // the free deterministic retry with the next verified candidate.
    const missing =
      "locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for locator('#gone')";
    expect(classifyFailure(missing).failureClass).toBe('selector-not-found');
  });
});

describe('repair policy', () => {
  it.each([
    ['selector-not-found', true],
    ['assertion-mismatch', true],
    ['timeout', true],
    ['navigation', true],
    ['env', false],
    ['unknown', false],
  ] as const)('isRepairable(%s) => %s', (failureClass, expected) => {
    expect(isRepairable(failureClass)).toBe(expected);
  });

  it('never repairs an env failure', () => {
    // A master-plan exit criterion. Patching a test cannot start a stopped
    // server, and the attempt burns the LOCKED 2-iteration budget while
    // producing a diff that makes the suite worse.
    expect(isRepairable('env')).toBe(false);
  });

  it('never repairs a failure it could not classify', () => {
    expect(isRepairable('unknown')).toBe(false);
  });

  it('tries a deterministic selector retry only where one could help', () => {
    expect(deservesSelectorRetry('selector-not-found')).toBe(true);
    for (const other of [
      'assertion-mismatch',
      'timeout',
      'navigation',
      'env',
      'unknown',
    ] as const) {
      expect(deservesSelectorRetry(other)).toBe(false);
    }
  });

  it('treats only assertion mismatches as possible application defects', () => {
    // A selector that cannot be found means the test is out of date. A value
    // that is wrong means either the test or the app is — and saying so is the
    // point.
    expect(mayBeAppDefect('assertion-mismatch')).toBe(true);
    for (const other of [
      'selector-not-found',
      'timeout',
      'navigation',
      'env',
      'unknown',
    ] as const) {
      expect(mayBeAppDefect(other)).toBe(false);
    }
  });
});
