import type { TestResult } from '../schemas/run-report.js';

/**
 * Establish that a test is actually broken before anything patches it.
 *
 * The scaffolded Playwright config runs `fullyParallel: true` with `retries: 0`
 * outside CI, so Playwright's own flaky detection never fires on a local run.
 * Nothing else in the pipeline can tell "this test is wrong" apart from "this
 * test was disturbed by another test running beside it" — and those need
 * opposite responses. Patching the second kind corrupts a test that was
 * correct.
 *
 * So every failing test is re-run **on its own, unchanged**, before repair is
 * considered. The master plan's own definition applies to what comes back:
 * pass-on-retry without a code change is `flaky`, and flaky tests are not
 * repaired.
 *
 * The cost is one scoped Playwright run per failing test. That is cheap next to
 * a model call, and far cheaper than a suite that has been "repaired" into
 * agreeing with whatever happened to run first.
 */

export type IsolationVerdict =
  /** Failed in the suite, passed alone: interference or genuine flakiness. */
  | 'flaky'
  /** Failed both ways. The failure is the test's own, and repair may proceed. */
  | 'genuine'
  /** The isolated run did not happen, so nothing was learned. */
  | 'inconclusive';

/**
 * Compare a suite failure against the same test run on its own.
 *
 * `undefined` for the isolated result means the re-run could not be scoped or
 * did not produce this test — which must read as "we learned nothing", never as
 * "it is fine". Repair proceeds in that case, because leaving a genuinely
 * broken test unrepaired on the strength of a run that never happened would
 * repeat the exact mistake this phase was built to avoid.
 */
export function isolationVerdict(isolated: TestResult | undefined): IsolationVerdict {
  if (isolated === undefined) return 'inconclusive';
  if (isolated.status === 'passed') return 'flaky';
  return 'genuine';
}

/**
 * Re-badge a test that only fails alongside others.
 *
 * `flaky` rather than `failed`, per the master plan. The error text from the
 * suite run is kept: it is the evidence for what interfered, and dropping it
 * would leave a human with a "flaky" label and nothing to act on.
 */
export function markFlaky(test: TestResult): TestResult {
  const { failureClass: _dropped, ...rest } = test;
  return { ...rest, status: 'flaky' };
}

/**
 * The advice a run earns when tests only fail in company.
 *
 * Two concrete remedies, in the order worth trying: serial mode proves the
 * diagnosis in one run, and unique test data fixes it without giving up
 * parallelism.
 */
export function collisionAdvice(flakyTitles: readonly string[]): string[] {
  if (flakyTitles.length === 0) return [];
  const lines = [`${flakyTitles.length} test(s) failed in the full run but passed when run alone:`];
  for (const title of flakyTitles) lines.push(`  ~ ${title}`);
  lines.push('');
  lines.push('Nothing in the code changed between those two runs, so these are not test');
  lines.push('defects and repair will not touch them. Two causes account for most of it:');
  lines.push('');
  lines.push('  Shared state — two tests using the same account, cart or record.');
  lines.push('    1. Confirm it: re-run with `--workers=1`. If everything passes, it is');
  lines.push('       interference rather than flakiness in the application.');
  lines.push('    2. Fix it without losing parallelism: give each test its own data');
  lines.push('       (unique suffixes in a factory), or mark the colliding file');
  lines.push('       `test.describe.serial`.');
  lines.push('');
  lines.push('  Session expiry — the login went stale partway through a long run, so');
  lines.push('  everything after a certain point failed and each test passes alone.');
  lines.push('  Check whether the failures cluster at the end of the run; if so, shorten');
  lines.push('  the run or refresh auth per worker rather than once per suite.');
  return lines;
}
