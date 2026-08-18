import { describe, it, expect } from 'vitest';
import { buildPrContent, commitMessage } from './body.js';
import type { RunReport } from '../schemas/run-report.js';
import type { TestPlan } from '../schemas/test-plan.js';

/**
 * A reviewer opening a generated PR has one question: should I trust these
 * tests? These pin that the body answers it honestly — leading with what ran,
 * never implying green when nothing was verified, and naming everything that
 * did not pass.
 */

function plan(over: Partial<TestPlan> = {}): TestPlan {
  return {
    featureId: 'login',
    generatedAt: '2026-01-01T00:00:00.000Z',
    screenModelVersion: 'model-1',
    cases: [{ id: 'c1', title: 'signs in', priority: 'p0', tags: [], status: 'new', steps: [] }],
    ...over,
  } as TestPlan;
}

function report(over: Partial<RunReport> = {}): RunReport {
  return {
    runId: 'r1',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:01:00.000Z',
    baseUrl: 'https://shop.example.com',
    envHealthy: true,
    summary: { total: 4, passed: 3, failed: 1, skipped: 0, flaky: 0, fixme: 0 },
    tests: [
      { title: 'signs in', status: 'passed', repairAttempts: 0 },
      {
        title: 'rejects a bad password',
        status: 'failed',
        failureClass: 'selector',
        errorExcerpt: 'locator resolved to 0 elements\n  at line 12',
        repairAttempts: 2,
      },
    ],
    ...over,
  } as RunReport;
}

function build(over: Partial<Parameters<typeof buildPrContent>[0]> = {}) {
  return buildPrContent({
    plans: [plan()],
    report: report(),
    baseUrl: 'https://shop.example.com',
    featureIds: ['login'],
    ...over,
  });
}

describe('buildPrContent', () => {
  it('leads with what ran, not with what was generated', () => {
    // "Adds 12 tests" says nothing about whether they work.
    expect(build().body.split('\n')[0]).toBe('**3 of 4 tests pass; 1 fail.**');
  });

  it('says plainly when the suite was never run', () => {
    const content = buildPrContent({
      plans: [plan()],
      baseUrl: 'https://shop.example.com',
      featureIds: ['login'],
    });
    expect(content.body).toContain('**Not verified**');
    expect(content.body).toContain('This suite was not run.');
  });

  it('refuses to imply green when the app was unreachable', () => {
    const content = build({ report: report({ envHealthy: false }) });
    expect(content.body.split('\n')[0]).toContain('Not verified');
    expect(content.body).toContain('not reachable');
  });

  it('calls out a run where nothing actually executed', () => {
    const content = build({
      report: report({
        summary: { total: 3, passed: 0, failed: 0, skipped: 2, flaky: 0, fixme: 1 },
        tests: [],
      }),
    });
    expect(content.body).toContain('**Nothing ran**');
  });

  it('names every test that did not pass, with its reason', () => {
    const body = build().body;
    expect(body).toContain('rejects a bad password');
    expect(body).toContain('selector');
    expect(body).toContain('locator resolved to 0 elements');
  });

  it('surfaces possible application defects separately from broken tests', () => {
    const content = build({
      report: report({
        tests: [
          {
            title: 'shows the right total',
            file: 'e2e/cart.spec.ts',
            status: 'failed',
            failureClass: 'assertion-mismatch',
            possibleAppDefect: true,
            repairAttempts: 2,
          },
        ],
      }),
    });
    expect(content.body).toContain('Possible application defects');
    expect(content.body).toContain('shows the right total');
  });

  it('explains blocked cases rather than dropping them', () => {
    const content = build({
      plans: [
        plan({
          cases: [
            {
              id: 'c2',
              title: 'sends a welcome email',
              priority: 'p1',
              tags: [],
              status: 'blocked',
              blockedReason: 'No email inbox is reachable from the Screen Model.',
              steps: [],
            },
          ],
        } as Partial<TestPlan>),
      ],
    });
    expect(content.body).toContain('Blocked');
    expect(content.body).toContain('No email inbox is reachable');
  });

  it('titles by feature, and collapses a long list to a count', () => {
    expect(build().title).toBe('test: generated Playwright coverage for login');
    expect(build({ featureIds: ['a', 'b', 'c', 'd'] }).title).toContain('4 features');
  });

  it('sorts features so the body is stable across runs', () => {
    const content = build({
      plans: [plan({ featureId: 'zebra' }), plan({ featureId: 'apple' })],
      featureIds: ['zebra', 'apple'],
    });
    expect(content.body.indexOf('`apple`')).toBeLessThan(content.body.indexOf('`zebra`'));
  });
});

describe('commitMessage', () => {
  it('carries the run result in the body', () => {
    expect(commitMessage(['login'], report())).toContain('3 passed, 1 failed');
  });

  it('says it was not run when there is no report', () => {
    expect(commitMessage(['login'], undefined)).toContain('Not run.');
  });
});
