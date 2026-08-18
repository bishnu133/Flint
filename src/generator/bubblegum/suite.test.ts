import { describe, it, expect } from 'vitest';
import type { SuiteManifest } from '../../schemas/manifest.js';
import type { ScreenModel, Element } from '../../schemas/screen-model.js';
import type { TestCase, TestPlan } from '../../schemas/test-plan.js';
import { buildSuite, flowName } from './suite.js';
import { matchFlowPrefix, phraseMatches, resolveAuth } from './reuse.js';

/**
 * "Never invent a flow" is this dialect's "never invent a selector", and it
 * needs the same kind of evidence. A model asked to reuse the login writes
 * `loginToPortal()` when the export is `loginFlow`: the file compiles, imports
 * something that does not exist, and fails at run time.
 */

const element = (id: string, name: string, over: Partial<Element> = {}): Element => ({
  id,
  role: 'button',
  name,
  tagName: 'button',
  boundingBox: { x: 0, y: 0, width: 1, height: 1 },
  states: { visible: true, enabled: true },
  selectorCandidates: [],
  ...over,
});

const MODEL: ScreenModel = {
  version: '2026-08-18T00:00:00.000Z',
  baseUrl: 'https://portal.test',
  capturedAt: '2026-08-18T00:00:00.000Z',
  pages: [
    {
      id: 'page-login',
      url: 'https://portal.test/',
      urlPattern: '/',
      title: 'Sign in',
      reachedVia: { kind: 'link', href: 'https://portal.test/' },
      elements: [
        element('el-user', 'Username', { role: 'textbox' }),
        element('el-pass', 'Password', { role: 'textbox' }),
        element('el-signin', 'Sign In'),
        element('el-tab', 'Facilitators'),
        element('el-add', 'Add a facilitator'),
      ],
      navTargets: [],
      capturedAt: '2026-08-18T00:00:00.000Z',
    },
  ],
};

const LOGIN_FLOW = {
  id: 'login.loginFlow',
  file: 'flows/login.flow.ts',
  exportName: 'loginFlow',
  domain: 'login',
  kind: 'auth' as const,
  summary: 'Performs login on the Keycloak auth page.',
  params: [
    { name: 'engine', type: 'Bubblegum' },
    { name: 'page', type: 'Page' },
    { name: 'credentials', type: 'LoginCredentials' },
  ],
  returns: 'Promise<void>',
  phrases: [
    'Enter "${credentials.username}" into Username',
    'Enter "${credentials.password}" into Password',
    'Click Sign In',
  ],
  usedBy: [],
};

const MANIFEST: SuiteManifest = {
  version: 1,
  generatedAt: '2026-08-18T00:00:00.000Z',
  suiteDir: 'e2e',
  roots: [],
  flows: [
    LOGIN_FLOW,
    {
      ...LOGIN_FLOW,
      id: 'login.logoutFlow',
      exportName: 'logoutFlow',
      params: [
        { name: 'engine', type: 'Bubblegum' },
        { name: 'page', type: 'Page' },
      ],
      phrases: ['Click on the My Account menu', 'Click Logout'],
    },
  ],
  data: [],
  helpers: [],
  credentials: [
    { getter: 'getVendorAdminCredentials', file: 'packages/data/BAP.ts', role: 'Vendor admin' },
  ],
  repositories: [],
  warnings: [],
};

const LOGIN_STEPS: TestCase['steps'] = [
  { action: 'fill', elementRef: 'el-user', value: 'smoke.vendor.user' },
  { action: 'fill', elementRef: 'el-pass', value: 'Password@123' },
  { action: 'click', elementRef: 'el-signin' },
];

const plan = (cases: TestCase[]): TestPlan => ({
  featureId: 'vendor-admin-view-facilitators',
  generatedAt: '2026-08-18T00:00:00.000Z',
  screenModelVersion: MODEL.version,
  cases,
});

const testCase = (over: Partial<TestCase> = {}): TestCase => ({
  id: 'case-1',
  title: 'Vendor Admin sees the Facilitators tab',
  priority: 'p0',
  tags: [],
  status: 'new',
  steps: [...LOGIN_STEPS, { action: 'click', elementRef: 'el-tab' }],
  ...over,
});

const build = (cases: TestCase[], credentialGetters: string[] = ['getVendorAdminCredentials']) =>
  buildSuite({
    plan: plan(cases),
    model: MODEL,
    manifest: MANIFEST,
    title: 'Vendor Admin facilitator listing',
    credentialGetters,
  });

describe('phraseMatches', () => {
  it('lets a template hole stand for any value', () => {
    expect(
      phraseMatches('Enter "${credentials.username}" into Username', 'Enter "alice" into Username'),
    ).toBe(true);
  });

  it('requires everything outside a hole to match exactly', () => {
    // A flow that clicks Sign In does not stand in for a step that clicks
    // Sign Up.
    expect(phraseMatches('Click Sign In', 'Click Sign Up')).toBe(false);
  });

  it('does not match a non-spoken step', () => {
    expect(phraseMatches('Click Sign In', undefined)).toBe(false);
  });
});

describe('matchFlowPrefix', () => {
  const spoken = (...texts: string[]) =>
    texts.map((text) => ({ kind: 'act' as const, text, elementId: 'x' }));

  it('recognises a login the suite already performs', () => {
    const match = matchFlowPrefix(
      spoken(
        'Enter "alice" into Username',
        'Enter "hunter2" into Password',
        'Click Sign In',
        'Click Facilitators',
      ),
      MANIFEST,
    );
    expect(match?.flow.id).toBe('login.loginFlow');
    expect(match?.consumed).toBe(3);
  });

  it('matches only at the beginning', () => {
    // Splicing a login out of the middle would leave the steps around it
    // depending on state the call no longer produces in that order.
    const match = matchFlowPrefix(
      spoken('Click Facilitators', 'Enter "alice" into Username'),
      MANIFEST,
    );
    expect(match).toBeUndefined();
  });

  it('reuses nothing when the opening differs', () => {
    expect(matchFlowPrefix(spoken('Click Facilitators'), MANIFEST)).toBeUndefined();
  });
});

describe('resolveAuth', () => {
  it('pairs the one login flow with a grounded credential getter', () => {
    const auth = resolveAuth(MANIFEST, ['getVendorAdminCredentials']);
    expect(auth?.flow.id).toBe('login.loginFlow');
    expect(auth?.getter).toBe('getVendorAdminCredentials');
  });

  it('does not mistake the logout flow for a login', () => {
    // Both are kind: 'auth' and the distinction is not recorded, so it is read
    // from the name. Getting it wrong opens every test by signing out.
    const auth = resolveAuth(MANIFEST, ['getVendorAdminCredentials']);
    expect(auth?.flow.exportName).toBe('loginFlow');
  });

  it('declines a getter the suite does not export', () => {
    expect(resolveAuth(MANIFEST, ['getInventedCredentials'])).toBeUndefined();
  });
});

describe('buildSuite', () => {
  it('calls the existing login instead of re-driving it', () => {
    const suite = build([testCase()]);
    const [test] = suite.tests;
    expect(test!.reuse).toEqual([
      {
        flowId: 'login.loginFlow',
        exportName: 'loginFlow',
        importPath: 'flows/login.flow.ts',
        args: ['getVendorAdminCredentials()'],
      },
    ]);
    expect(test!.notes[0]).toContain('login.loginFlow');
  });

  it('keeps only the steps the reused flow does not perform', () => {
    const suite = build([testCase()]);
    expect(suite.flows).toHaveLength(1);
    expect(suite.flows[0]!.steps.map((s) => ('text' in s ? s.text : s.kind))).toEqual([
      'Click Facilitators',
    ]);
  });

  it('imports the credential getter the role grounded to', () => {
    expect(build([testCase()]).credentialImports).toEqual([
      { getter: 'getVendorAdminCredentials', importPath: 'packages/data/BAP.ts' },
    ]);
  });

  it('splits driving from asserting, because a flow that asserts cannot be reused', () => {
    const suite = build([
      testCase({
        steps: [
          ...LOGIN_STEPS,
          { action: 'click', elementRef: 'el-tab' },
          { action: 'assert', elementRef: 'el-add', assertion: { kind: 'hidden', expected: true } },
        ],
      }),
    ]);
    expect(suite.flows[0]!.steps).toHaveLength(1);
    expect(suite.tests[0]!.checks.map((c) => ('text' in c ? c.text : c.kind))).toEqual([
      'Add a facilitator is not visible',
    ]);
  });
});

describe('what is emitted but not run', () => {
  it('marks an ungrounded step fixme, because the compile gate cannot catch it', () => {
    // `playwright-pom` has no equivalent: a missing locator will not build.
    // Here the file compiles perfectly and fails in CI as a resolver timeout.
    const suite = build([
      testCase({ steps: [...LOGIN_STEPS, { action: 'click', elementRef: 'el-ghost' }] }),
    ]);
    expect(suite.tests[0]!.mode).toEqual({
      kind: 'fixme',
      reason: expect.stringContaining('el-ghost'),
    });
  });

  it('will not claim a login it cannot read, and refuses instead', () => {
    // The tempting behaviour is to reuse anyway — the generated code would
    // never touch the missing element, so the test would run. But the phrase is
    // the evidence, and a step that cannot be phrased is a step that cannot be
    // shown to belong to the login. Reusing on a partial match would be the
    // guessing this whole design exists to refuse, so a gap inside the prefix
    // costs the reuse and the test says why.
    const model: ScreenModel = {
      ...MODEL,
      pages: [
        {
          ...MODEL.pages[0]!,
          elements: MODEL.pages[0]!.elements.filter((e) => e.id !== 'el-pass'),
        },
      ],
    };
    const suite = buildSuite({
      plan: plan([testCase()]),
      model,
      manifest: MANIFEST,
      title: 'x',
      credentialGetters: ['getVendorAdminCredentials'],
    });
    expect(suite.tests[0]!.mode).toEqual({
      kind: 'fixme',
      reason: expect.stringContaining('el-pass'),
    });
    expect(suite.tests[0]!.reuse).toEqual([]);
  });

  it('keeps the LOCKED precedence: blocked beats everything', () => {
    const suite = build([testCase({ status: 'blocked', blockedReason: 'no such screen' })]);
    expect(suite.tests[0]!.mode).toEqual({ kind: 'fixme', reason: 'no such screen' });
  });

  it('writes the whole test but skips it when something must exist first', () => {
    const suite = build([
      testCase({
        prerequisites: [{ kind: 'data', description: 'a seeded facilitator' }],
      }),
    ]);
    expect(suite.tests[0]!.mode).toEqual({
      kind: 'skip',
      reason: 'data: a seeded facilitator',
    });
    expect(suite.flows[0]!.steps).toHaveLength(1);
  });

  it('drops a duplicate rather than emitting it twice', () => {
    const suite = build([
      testCase(),
      testCase({ id: 'case-2', status: 'skipped-duplicate', duplicateOf: 'existing-1' }),
    ]);
    expect(suite.tests.map((t) => t.caseId)).toEqual(['case-1']);
  });
});

describe('flowName', () => {
  it('makes a valid identifier from a case id', () => {
    expect(flowName('case-1')).toBe('case1Flow');
    expect(flowName('view-facilitator-listing')).toBe('viewFacilitatorListingFlow');
  });

  it('survives an id that starts with a digit', () => {
    expect(flowName('17236-view')).toBe('case17236ViewFlow');
  });
});

describe('determinism', () => {
  it('builds the same suite twice', () => {
    // Regenerating has to be byte-identical or the managed marker churns and
    // every review carries noise.
    expect(build([testCase()])).toEqual(build([testCase()]));
  });
});
