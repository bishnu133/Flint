import { describe, it, expect } from 'vitest';
import {
  MAX_REPAIR_ITERATIONS,
  repairHistoryComment,
  repairTest,
  type RepairDeps,
} from './repair.js';
import type { TestResult } from '../schemas/run-report.js';
import type { Element, ScreenModel, SelectorCandidate } from '../schemas/screen-model.js';

/**
 * The caps get the most attention here. A repair loop without a hard iteration
 * limit and a wall-clock budget is the failure mode that costs a user an
 * afternoon and a fortune, and it is invisible until it happens.
 */

function candidate(over: Partial<SelectorCandidate> = {}): SelectorCandidate {
  return {
    strategy: 'testid',
    value: '[data-test="a"]',
    score: 100,
    unique: true,
    verified: true,
    ...over,
  };
}

const ELEMENT: Element = {
  id: 'el-login',
  role: 'button',
  name: 'Login',
  tagName: 'button',
  boundingBox: { x: 0, y: 0, width: 1, height: 1 },
  states: { visible: true, enabled: true },
  selectorCandidates: [
    candidate({ strategy: 'testid', value: '[data-test="a"]', score: 100 }),
    candidate({ strategy: 'role', value: 'button[name="Login"]', score: 85 }),
    candidate({ strategy: 'css', value: 'form > button', score: 30 }),
  ],
};

const MODEL: ScreenModel = {
  version: 'm',
  baseUrl: 'https://app.example.com',
  capturedAt: '2026-01-01T00:00:00.000Z',
  pages: [
    {
      id: 'p1',
      url: 'https://app.example.com/',
      urlPattern: '/',
      title: 'Home',
      reachedVia: { kind: 'link', href: '/' },
      navTargets: [],
      capturedAt: '2026-01-01T00:00:00.000Z',
      elements: [ELEMENT],
    },
  ],
};

const PAGE_OBJECT = `export class HomePage {
  constructor(page) {
    this.loginButton = this.page.locator('[data-test="a"]');
  }
}
`;

function failing(over: Partial<TestResult> = {}): TestResult {
  return {
    title: 'signs in',
    file: 'tests/login.spec.ts',
    status: 'failed',
    failureClass: 'selector-not-found',
    errorExcerpt: `locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for locator('[data-test="a"]')`,
    repairAttempts: 0,
    ...over,
  };
}

/** Records what the loop did, and lets a test choose when the re-run passes. */
function deps(over: Partial<RepairDeps> & { passOnAttempt?: number } = {}): RepairDeps & {
  writes: Array<{ file: string; contents: string }>;
  reruns: number;
  read: (path: string) => string | undefined;
} {
  const writes: Array<{ file: string; contents: string }> = [];
  let reruns = 0;
  const files = new Map<string, string>([['pages/home.page.ts', PAGE_OBJECT]]);

  const base: RepairDeps = {
    readFile: (path) => files.get(path),
    writeFile: (path, contents) => {
      files.set(path, contents);
      writes.push({ file: path, contents });
    },
    rerun: (test) => {
      reruns += 1;
      // A re-run reports the failure the test still has. Returning a fixed
      // class instead would let a timeout test come back as selector-not-found
      // and silently switch the loop onto the deterministic path — which is
      // exactly the confound this fake existed to avoid.
      return over.passOnAttempt === reruns
        ? { ...failing(), status: 'passed', failureClass: undefined, errorExcerpt: undefined }
        : failing({
            ...(test.failureClass !== undefined ? { failureClass: test.failureClass } : {}),
            ...(test.errorExcerpt !== undefined ? { errorExcerpt: test.errorExcerpt } : {}),
          });
    },
    pageObjectFiles: () => ['pages/home.page.ts'],
    ...over,
  };
  return Object.assign(base, {
    get writes() {
      return writes;
    },
    get reruns() {
      return reruns;
    },
    read: (path: string) => files.get(path),
  });
}

describe('repairTest — what it refuses', () => {
  it('never repairs an environmental failure', async () => {
    // Patching a test cannot start a stopped server. A master-plan criterion.
    const d = deps();
    const outcome = await repairTest({
      test: failing({ failureClass: 'env' }),
      model: MODEL,
      deps: d,
    });
    expect(outcome.repaired).toBe(false);
    expect(outcome.attempts).toEqual([]);
    expect(d.reruns).toBe(0);
    expect(d.writes).toEqual([]);
    expect(outcome.gaveUpBecause).toMatch(/environmental/);
  });

  it('never repairs a failure it could not classify', async () => {
    // A blind edit to code that might be correct is how a repair loop corrupts
    // a suite.
    const d = deps();
    const outcome = await repairTest({
      test: failing({ failureClass: 'unknown' }),
      model: MODEL,
      deps: d,
    });
    expect(d.writes).toEqual([]);
    expect(outcome.gaveUpBecause).toMatch(/blind edit/);
  });

  it('does nothing for a test that passed', async () => {
    const d = deps();
    const outcome = await repairTest({
      test: failing({ status: 'passed', failureClass: undefined }),
      model: MODEL,
      deps: d,
    });
    expect(outcome.repaired).toBe(false);
    expect(d.reruns).toBe(0);
  });
});

describe('repairTest — the caps', () => {
  it('stops at the LOCKED iteration maximum', async () => {
    const d = deps(); // never passes
    const outcome = await repairTest({ test: failing(), model: MODEL, deps: d });
    expect(outcome.repaired).toBe(false);
    expect(outcome.attempts.length).toBeLessThanOrEqual(MAX_REPAIR_ITERATIONS);
    expect(d.reruns).toBeLessThanOrEqual(MAX_REPAIR_ITERATIONS);
  });

  it('stops when the wall-clock budget is gone, even with iterations left', async () => {
    // Two independent brakes. A test that hangs must not consume the run.
    let clock = 0;
    const d = deps({ now: () => (clock += 10_000) });
    const outcome = await repairTest({ test: failing(), model: MODEL, deps: d, budgetMs: 1 });
    expect(outcome.attempts).toEqual([]);
    expect(d.reruns).toBe(0);
    expect(outcome.gaveUpBecause).toMatch(/budget/);
  });

  it('never re-tries a selector it has already tried', async () => {
    // Otherwise both locked iterations get spent re-proposing the failure.
    const d = deps();
    await repairTest({ test: failing(), model: MODEL, deps: d });
    const used = d.writes.map((w) => w.contents);
    expect(new Set(used).size).toBe(used.length);
  });
});

describe('repairTest — when it works', () => {
  it('swaps in the next verified selector and keeps it when the re-run passes', async () => {
    const d = deps({ passOnAttempt: 1 });
    const outcome = await repairTest({ test: failing(), model: MODEL, deps: d });

    expect(outcome.repaired).toBe(true);
    expect(outcome.result.status).toBe('passed');
    expect(outcome.result.repairAttempts).toBe(1);
    expect(d.writes[0]?.contents).toContain('getByRole');
    expect(d.writes[0]?.contents).not.toContain('[data-test="a"]');
    expect(outcome.attempts[0]).toMatchObject({ kind: 'selector-retry', passed: true });
  });

  it('tries a second candidate when the first replacement also fails', async () => {
    const d = deps({ passOnAttempt: 2 });
    const outcome = await repairTest({ test: failing(), model: MODEL, deps: d });
    expect(outcome.repaired).toBe(true);
    expect(outcome.attempts).toHaveLength(2);
    expect(d.writes[1]?.contents).toContain('form > button');
  });

  it('gives up cleanly when the element has no other verified selector', async () => {
    const oneCandidate: ScreenModel = {
      ...MODEL,
      pages: [
        { ...MODEL.pages[0]!, elements: [{ ...ELEMENT, selectorCandidates: [candidate()] }] },
      ],
    };
    const d = deps();
    const outcome = await repairTest({ test: failing(), model: oneCandidate, deps: d });
    expect(outcome.repaired).toBe(false);
    expect(d.writes).toEqual([]);
    expect(outcome.gaveUpBecause).toMatch(/no other verified selector/);
  });

  it('refuses rather than guessing when the page object is not what it expects', async () => {
    const d = deps({ readFile: () => 'a page object nobody generated' });
    const outcome = await repairTest({ test: failing(), model: MODEL, deps: d });
    expect(d.writes).toEqual([]);
    expect(outcome.repaired).toBe(false);
  });
});

describe('repairTest — assertion mismatches', () => {
  it('marks a surviving assertion mismatch as a possible application defect', async () => {
    // The headline finding, not a footnote: the app may genuinely be wrong.
    const d = deps();
    const outcome = await repairTest({
      test: failing({
        failureClass: 'assertion-mismatch',
        errorExcerpt: 'Expected: "Welcome"\nReceived: "Error"',
      }),
      model: MODEL,
      deps: d,
    });
    expect(outcome.result.possibleAppDefect).toBe(true);
    expect(d.writes).toEqual([]);
  });

  it('does not claim an app defect for a selector failure', async () => {
    const outcome = await repairTest({ test: failing(), model: MODEL, deps: deps() });
    expect(outcome.result.possibleAppDefect).toBeUndefined();
  });
});

describe('repairHistoryComment', () => {
  it('tells a human what was tried and what is still wrong', async () => {
    const outcome = await repairTest({ test: failing(), model: MODEL, deps: deps() });
    const comment = repairHistoryComment(outcome).join('\n');
    expect(comment).toMatch(/could not repair/);
    expect(comment).toMatch(/Repair attempts:/);
    expect(comment).toMatch(/selector-retry/);
    expect(comment).toMatch(/Last error:/);
  });

  it('flags a possible application defect prominently', async () => {
    const outcome = await repairTest({
      test: failing({ failureClass: 'assertion-mismatch' }),
      model: MODEL,
      deps: deps(),
    });
    expect(repairHistoryComment(outcome).join('\n')).toMatch(/may be a real defect/);
  });
});

/**
 * The model path runs only after the deterministic one has nothing left. These
 * tests use a stub proposer rather than a provider — the provider-facing checks
 * live in `llm-repair.test.ts`; what matters here is what the *loop* does with
 * a proposal once it has one.
 */
describe('repairTest — the model path', () => {
  const ROLE_EXPRESSION = `this.page.getByRole('button', { name: 'Login', exact: true })`;

  /** A proposer that swaps the locator, so a patch is observable in the file. */
  function proposer(calls: { n: number }) {
    return async (input: {
      files: Array<{ path: string; contents: string }>;
    }): Promise<{
      applied?: { diagnosis: string; files: Array<{ path: string; contents: string }> };
    }> => {
      calls.n += 1;
      const file = input.files[0]!;
      return {
        applied: {
          diagnosis: 'the locator moved',
          files: [
            {
              path: file.path,
              contents: file.contents.replace(
                `this.page.locator('[data-test="a"]')`,
                ROLE_EXPRESSION,
              ),
            },
          ],
        },
      };
    };
  }

  it('is not consulted while a verified selector is still untried', async () => {
    // Ordering is the whole point: the free, unfakeable option goes first.
    const calls = { n: 0 };
    const d = deps({ passOnAttempt: 1, proposeRepair: proposer(calls) });
    const outcome = await repairTest({ test: failing(), model: MODEL, deps: d });
    expect(outcome.attempts[0]?.kind).toBe('selector-retry');
    expect(calls.n).toBe(0);
  });

  it('is consulted for a failure the selector retry cannot address', async () => {
    const calls = { n: 0 };
    const d = deps({ passOnAttempt: 1, proposeRepair: proposer(calls) });
    const outcome = await repairTest({
      test: failing({ failureClass: 'timeout', errorExcerpt: 'Test timeout of 30000ms exceeded' }),
      model: MODEL,
      deps: d,
    });
    expect(calls.n).toBe(1);
    expect(outcome.attempts[0]?.kind).toBe('llm');
    expect(outcome.repaired).toBe(true);
  });

  it('keeps a model patch that made the test pass', async () => {
    const d = deps({ passOnAttempt: 1, proposeRepair: proposer({ n: 0 }) });
    await repairTest({ test: failing({ failureClass: 'timeout' }), model: MODEL, deps: d });
    expect(d.read('pages/home.page.ts')).toContain('getByRole');
  });

  it('reverts a model patch that did not', async () => {
    // Unreviewed model-authored code left behind in a suite that is still
    // failing is worse than the failure. A verified-selector swap is left in
    // place; this is not.
    const d = deps({ proposeRepair: proposer({ n: 0 }) });
    const outcome = await repairTest({
      test: failing({ failureClass: 'timeout' }),
      model: MODEL,
      deps: d,
    });
    expect(outcome.repaired).toBe(false);
    expect(d.read('pages/home.page.ts')).toBe(PAGE_OBJECT);
    expect(d.read('pages/home.page.ts')).not.toContain('getByRole');
  });

  it('declines with the reason the model gave, rather than inventing one', async () => {
    const d = deps({
      proposeRepair: () =>
        Promise.resolve({ rejected: 'the application looks wrong, not the test' }),
    });
    const outcome = await repairTest({
      test: failing({ failureClass: 'assertion-mismatch' }),
      model: MODEL,
      deps: d,
    });
    expect(outcome.repaired).toBe(false);
    expect(d.writes).toEqual([]);
    expect(outcome.gaveUpBecause).toMatch(/the application looks wrong/);
  });

  it('says a model was never configured instead of implying one was tried', async () => {
    const outcome = await repairTest({
      test: failing({ failureClass: 'timeout' }),
      model: MODEL,
      deps: deps(),
    });
    expect(outcome.gaveUpBecause).toMatch(/no model is configured/);
    expect(outcome.gaveUpBecause).toMatch(/no deterministic repair applies/);
  });

  it('distinguishes "does not apply" from "ran out of selectors"', async () => {
    // Two different facts about why the deterministic half produced nothing.
    // Collapsing them would mislead whoever reads the report.
    const oneCandidate: ScreenModel = {
      ...MODEL,
      pages: [
        { ...MODEL.pages[0]!, elements: [{ ...ELEMENT, selectorCandidates: [candidate()] }] },
      ],
    };
    const outcome = await repairTest({ test: failing(), model: oneCandidate, deps: deps() });
    expect(outcome.gaveUpBecause).toMatch(/no other verified selector/);
  });

  it('still honours the locked iteration cap when the model is doing the work', async () => {
    const calls = { n: 0 };
    const d = deps({ proposeRepair: proposer(calls) });
    await repairTest({ test: failing({ failureClass: 'timeout' }), model: MODEL, deps: d });
    expect(calls.n).toBeLessThanOrEqual(MAX_REPAIR_ITERATIONS);
  });

  it('names the model attempt in the history a human reads', async () => {
    const d = deps({ proposeRepair: proposer({ n: 0 }) });
    const outcome = await repairTest({
      test: failing({ failureClass: 'timeout' }),
      model: MODEL,
      deps: d,
    });
    const comment = repairHistoryComment(outcome).join('\n');
    expect(comment).toMatch(/\[llm\] the locator moved/);
  });
});
