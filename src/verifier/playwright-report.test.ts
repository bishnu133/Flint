import { describe, it, expect } from 'vitest';
import { parsePlaywrightReport } from './playwright-report.js';
import { TestResultSchema } from '../schemas/run-report.js';

/**
 * Fixtures mirror Playwright's real JSON reporter: file-level suites containing
 * describe-level suites, each with `specs`, each spec with `tests`, each test
 * with `results`. Flattening that wrong is the easiest way to lose half a run,
 * so the nesting is exercised rather than assumed.
 */

function report(suites: unknown[], errors: unknown[] = []): string {
  return JSON.stringify({ config: {}, suites, errors });
}

const PASSED = {
  title: 'login.spec.ts',
  file: 'tests/login.spec.ts',
  specs: [],
  suites: [
    {
      title: 'Sign in to Swag Labs',
      file: 'tests/login.spec.ts',
      specs: [
        {
          title: 'User opens the site root @feature:login @flint',
          ok: true,
          file: 'tests/login.spec.ts',
          tests: [{ status: 'expected', results: [{ status: 'passed', duration: 710 }] }],
        },
      ],
    },
  ],
};

describe('parsePlaywrightReport', () => {
  it('finds tests nested inside describe-level suites', () => {
    const { tests } = parsePlaywrightReport(report([PASSED]));
    expect(tests).toHaveLength(1);
    expect(tests[0]?.title).toBe('User opens the site root @feature:login @flint');
    expect(tests[0]?.file).toBe('tests/login.spec.ts');
    expect(tests[0]?.status).toBe('passed');
    expect(tests[0]?.durationMs).toBe(710);
  });

  it('classifies a failure and carries an excerpt', () => {
    const { tests } = parsePlaywrightReport(
      report([
        {
          file: 'tests/login.spec.ts',
          specs: [
            {
              title: 'shows an error',
              file: 'tests/login.spec.ts',
              tests: [
                {
                  status: 'unexpected',
                  results: [
                    {
                      status: 'failed',
                      duration: 30_000,
                      error: {
                        message:
                          'locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for locator(\'[data-test="gone"]\')',
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ]),
    );
    expect(tests[0]?.status).toBe('failed');
    expect(tests[0]?.failureClass).toBe('selector-not-found');
    expect(tests[0]?.errorExcerpt).toContain('waiting for locator');
  });

  it('always gives a failure the failureClass the LOCKED schema requires', () => {
    const { tests } = parsePlaywrightReport(
      report([
        {
          file: 'a.spec.ts',
          specs: [
            {
              title: 'no error text at all',
              file: 'a.spec.ts',
              tests: [{ status: 'unexpected', results: [{ status: 'failed' }] }],
            },
          ],
        },
      ]),
    );
    expect(TestResultSchema.safeParse(tests[0]).success).toBe(true);
    expect(tests[0]?.failureClass).toBe('unknown');
  });

  it('tells a fixme apart from an ordinary skip', () => {
    // They arrive identically as "skipped"; only the annotation distinguishes
    // them, and the difference is Flint's own marker versus waiting on setup.
    const { tests } = parsePlaywrightReport(
      report([
        {
          file: 'a.spec.ts',
          specs: [
            {
              title: 'blocked case',
              file: 'a.spec.ts',
              tests: [
                {
                  status: 'skipped',
                  annotations: [{ type: 'fixme' }],
                  results: [{ status: 'skipped' }],
                },
              ],
            },
            {
              title: 'needs setup',
              file: 'a.spec.ts',
              tests: [
                {
                  status: 'skipped',
                  annotations: [{ type: 'skip' }],
                  results: [{ status: 'skipped' }],
                },
              ],
            },
          ],
        },
      ]),
    );
    const byTitle = new Map(tests.map((t) => [t.title, t.status]));
    expect(byTitle.get('blocked case')).toBe('fixme');
    expect(byTitle.get('needs setup')).toBe('skipped');
  });

  it('reports a flaky test as flaky, not as passed', () => {
    // A test that only passes on retry is a defect worth surfacing, and it must
    // never enter the repair loop — nothing in the code changed.
    const { tests } = parsePlaywrightReport(
      report([
        {
          file: 'a.spec.ts',
          specs: [
            {
              title: 'sometimes works',
              file: 'a.spec.ts',
              tests: [
                {
                  status: 'flaky',
                  results: [
                    { status: 'failed', retry: 0 },
                    { status: 'passed', retry: 1 },
                  ],
                },
              ],
            },
          ],
        },
      ]),
    );
    expect(tests[0]?.status).toBe('flaky');
  });

  it('collects artifact paths for the report', () => {
    const { tests } = parsePlaywrightReport(
      report([
        {
          file: 'a.spec.ts',
          specs: [
            {
              title: 'failed with a trace',
              file: 'a.spec.ts',
              tests: [
                {
                  status: 'unexpected',
                  results: [
                    {
                      status: 'failed',
                      error: { message: 'Expected: 1\nReceived: 2' },
                      attachments: [
                        { name: 'screenshot', path: '/tmp/b.png' },
                        { name: 'trace', path: '/tmp/a.zip' },
                        { name: 'no-path' },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ]),
    );
    expect(tests[0]?.artifacts).toEqual(['/tmp/a.zip', '/tmp/b.png']);
  });

  it('surfaces top-level errors as run errors, not as test failures', () => {
    // A spec that fails to compile means no test ran. Counting that as a
    // failing test would send the repair loop after code that never executed.
    const { tests, runErrors } = parsePlaywrightReport(
      report([], [{ message: 'Error: No tests found' }]),
    );
    expect(tests).toEqual([]);
    expect(runErrors).toEqual(['Error: No tests found']);
  });

  it('reports unreadable output rather than throwing', () => {
    expect(parsePlaywrightReport('not json').runErrors[0]).toMatch(/not valid JSON/);
    expect(parsePlaywrightReport('{"suites": "wrong"}').runErrors[0]).toMatch(/unexpected shape/);
  });

  it('tolerates fields a newer Playwright adds', () => {
    // A strict schema here would turn "they upgraded Playwright" into "Flint
    // cannot read your results".
    const { tests } = parsePlaywrightReport(
      report([
        {
          file: 'a.spec.ts',
          somethingNew: true,
          specs: [
            {
              title: 'still parses',
              file: 'a.spec.ts',
              alsoNew: 42,
              tests: [{ status: 'expected', results: [{ status: 'passed', brandNew: 'x' }] }],
            },
          ],
        },
      ]),
    );
    expect(tests[0]?.status).toBe('passed');
  });

  it('orders results stably, because the report is written and diffed', () => {
    const twoFiles = [
      {
        file: 'b.spec.ts',
        specs: [{ title: 'b1', file: 'b.spec.ts', tests: [{ status: 'expected', results: [] }] }],
      },
      {
        file: 'a.spec.ts',
        specs: [{ title: 'a1', file: 'a.spec.ts', tests: [{ status: 'expected', results: [] }] }],
      },
    ];
    expect(parsePlaywrightReport(report(twoFiles)).tests.map((t) => t.file)).toEqual([
      'a.spec.ts',
      'b.spec.ts',
    ]);
  });

  it('strips ANSI colour codes out of the excerpt', () => {
    const { tests } = parsePlaywrightReport(
      report([
        {
          file: 'a.spec.ts',
          specs: [
            {
              title: 'coloured error',
              file: 'a.spec.ts',
              tests: [
                {
                  status: 'unexpected',
                  results: [
                    {
                      status: 'failed',
                      error: { message: 'Timeout\n[2m  - waiting for locator(#a)[22m' },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ]),
    );
    expect(tests[0]?.errorExcerpt).not.toContain(String.fromCharCode(27));
    expect(tests[0]?.errorExcerpt).toContain('waiting for locator');
  });
});
