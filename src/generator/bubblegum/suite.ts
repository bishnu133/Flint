import type { FlowEntry, SuiteManifest } from '../../schemas/manifest.js';
import type { ScreenModel } from '../../schemas/screen-model.js';
import type { TestCase, TestPlan } from '../../schemas/test-plan.js';
import { phraseFor, type Phrase } from './phrase.js';
import { matchFlowPrefix, resolveAuth } from './reuse.js';

/**
 * A TestPlan as a Bubblegum suite (B3).
 *
 * The four-layer pattern the dialect already uses in production — DATA, FLOW,
 * TEST, HELPERS — with the responsibilities the target suite's own code shows:
 * **flows drive, tests assert**. `loginFlow` performs three `act` calls and
 * checks nothing; the tests that call it do the verifying. So a case's `act`
 * steps become a flow function and its `verify` steps stay in the test, which
 * is also what makes flows reusable — a flow that asserted one feature's
 * expectations could not be called by another.
 *
 * This module decides *what* the suite contains. Rendering it to TypeScript is
 * `render.ts`, kept separate so the decisions are testable without matching
 * generated text.
 *
 * Everything here is a pure function of its inputs: no clock, no filesystem, no
 * randomness. Regenerating a feature has to be byte-identical or the managed
 * marker churns and every review contains noise.
 */

export interface BubblegumFlow {
  /** Exported function name, e.g. `viewFacilitatorListing`. */
  name: string;
  caseId: string;
  summary: string;
  /** `act` and `goto` phrases, in order. */
  steps: Phrase[];
}

/** A call to something the suite already had. Never to something invented. */
export interface ReusedCall {
  /** Manifest flow id, kept as evidence of where this came from. */
  flowId: string;
  exportName: string;
  importPath: string;
  /** Rendered argument expressions after `engine, page`. */
  args: string[];
}

export type TestMode =
  | { kind: 'live' }
  /** Complete test, not run: something must exist first. */
  | { kind: 'skip'; reason: string }
  /** Not runnable as written. Carries why, so nobody re-derives it. */
  | { kind: 'fixme'; reason: string };

export interface BubblegumTest {
  caseId: string;
  title: string;
  tags: string[];
  mode: TestMode;
  /**
   * Where the test navigates before driving anything.
   *
   * In the test rather than the flow, because that is where the suite's own
   * tests put it — and because a "flow" containing nothing but a `goto` is an
   * exported function that does not earn its name.
   */
  goto: string[];
  /** Flows from the manifest, called before this feature's own flow. */
  reuse: ReusedCall[];
  /** The generated flow this test drives with, if it has steps of its own. */
  flow?: string;
  /** `verify` and `url` phrases, in order. */
  checks: Phrase[];
  /** Rendered above the test for a human reviewer. */
  notes: string[];
}

export interface BubblegumSuite {
  featureId: string;
  title: string;
  baseUrl: string;
  flows: BubblegumFlow[];
  tests: BubblegumTest[];
  /** Credential getters the tests import, deduped and sorted. */
  credentialImports: Array<{ getter: string; importPath: string }>;
}

export interface BuildSuiteOptions {
  plan: TestPlan;
  model: ScreenModel;
  manifest: SuiteManifest;
  /** Feature title for the `describe` block. */
  title: string;
  /**
   * Credential getters this feature's roles grounded to, from `flint kb`.
   *
   * Passed in rather than re-derived so the emitter cannot reach a different
   * conclusion than the gap report the operator already read and approved.
   */
  credentialGetters?: string[];
  /**
   * Whether every `dataNeeds` entry in the spec is grounded.
   *
   * The planner writes its own `prerequisites` list, and on a live run it
   * restated preconditions the knowledge base had already answered: "a BAP user
   * with Vendor Admin role..." — which is the role being logged in with — and
   * "seed at least one vendor facilitator record", which is the state recorded
   * as provided by the environment. Four of seven cases were emitted skipped on
   * that basis, waiting for setup that exists.
   *
   * `dataNeeds` is the feature's declared data contract and `flint kb` checks
   * it. When it is fully grounded, a `data` prerequisite is a restatement, not
   * new information — so it stops blocking, and stays in the file as a note.
   * Prerequisites of any other kind still block: nothing has checked those.
   */
  dataNeedsGrounded?: boolean;
}

export function buildSuite(options: BuildSuiteOptions): BubblegumSuite {
  const { plan, model, manifest } = options;
  const byElementId = new Map(model.pages.flatMap((page) => page.elements.map((e) => [e.id, e])));
  const auth = resolveAuth(manifest, options.credentialGetters ?? []);

  const flows: BubblegumFlow[] = [];
  const tests: BubblegumTest[] = [];
  const getters = new Set<string>();

  for (const testCase of plan.cases) {
    if (testCase.status === 'skipped-duplicate') continue;

    const phrases = testCase.steps.map((step) =>
      phraseFor({
        step,
        ...(step.elementRef !== undefined && byElementId.has(step.elementRef)
          ? { element: byElementId.get(step.elementRef)! }
          : {}),
        baseUrl: model.baseUrl,
      }),
    );

    const built = buildTest({
      testCase,
      phrases,
      manifest,
      auth,
      dataNeedsGrounded: options.dataNeedsGrounded ?? false,
    });
    if (built.flow !== undefined) flows.push(built.flow);
    if (auth !== undefined && built.test.reuse.some((r) => r.flowId === auth.flow.id)) {
      getters.add(auth.getter);
    }
    tests.push(built.test);
  }

  return {
    featureId: plan.featureId,
    title: options.title,
    baseUrl: model.baseUrl,
    flows,
    tests,
    credentialImports: [...getters]
      .sort((a, b) => a.localeCompare(b))
      .map((getter) => ({
        getter,
        importPath: manifest.credentials.find((c) => c.getter === getter)?.file ?? '',
      })),
  };
}

interface BuildTestInput {
  testCase: TestCase;
  phrases: Phrase[];
  manifest: SuiteManifest;
  auth: { flow: FlowEntry; getter: string } | undefined;
  dataNeedsGrounded: boolean;
}

function buildTest(input: BuildTestInput): { test: BubblegumTest; flow?: BubblegumFlow } {
  const { testCase, manifest, auth } = input;
  const notes: string[] = [];
  const reuse: ReusedCall[] = [];

  // Reuse is attempted before refusal, and it only fires on proof: a phrase is
  // the evidence a step belongs to a known flow, so a step that could not be
  // phrased cannot be part of one. That costs a reuse where a gap sits inside
  // the login prefix — the test is refused rather than quietly matched on the
  // steps around the hole — and that is the safe direction. Matching partially
  // would be exactly the guessing this design refuses everywhere else.
  let phrases = input.phrases;
  const match = matchFlowPrefix(phrases, manifest);
  if (match !== undefined) {
    reuse.push(callFor(match.flow, auth));
    notes.push(
      `The first ${match.consumed} step(s) are \`${match.flow.id}\`, which this suite already has.`,
    );
    phrases = phrases.slice(match.consumed);
  }

  const ungrounded = phrases.filter((p) => p.kind === 'ungrounded');
  const mode = modeFor(testCase, ungrounded, input.dataNeedsGrounded);
  for (const covered of coveredPrerequisites(testCase, input.dataNeedsGrounded)) {
    notes.push(`Precondition already grounded in the knowledge base — ${covered}`);
  }

  if (match === undefined && auth !== undefined && ungrounded.length === 0) {
    // No login to collapse, and a live plan showed why that is the normal case
    // rather than the exception: the Screen Model is captured from an
    // authenticated crawl, so the planner never sees a sign-in page and every
    // case opens with `goto`. Left alone the emitted test would navigate as an
    // anonymous visitor and fail on the first assertion.
    //
    // The call is still grounded, just by the other route: the feature's
    // `dataNeeds` grounded to a role, the role names a credential getter, and
    // the manifest says which flow is auth — three links `flint kb` checked
    // before generation.
    //
    // Not added to a test that is already refused. A plan whose login could not
    // be read still contains those steps, so prepending a second sign-in would
    // put scaffolding in a file nobody can run and make the real problem harder
    // to see.
    reuse.push(callFor(auth.flow, auth));
    notes.push(
      `The plan does not sign in — the Screen Model was captured from an ` +
        `authenticated crawl — so the session comes from \`${auth.flow.id}\` ` +
        `with \`${auth.getter}()\`, which is the role this feature grounded to.`,
    );
  }

  // Leading navigation is lifted out to the test. Only leading: a `goto` in the
  // middle of a journey is part of that journey, and hoisting it would reorder
  // the steps around it.
  let lead = 0;
  while (phrases[lead]?.kind === 'goto') lead += 1;
  const goto = phrases
    .slice(0, lead)
    .map((p) => (p.kind === 'goto' ? p.url : ''))
    .filter((url) => url !== '');
  phrases = phrases.slice(lead);

  const steps = phrases.filter((p) => p.kind === 'act' || p.kind === 'goto');
  const checks = phrases.filter((p) => p.kind === 'verify' || p.kind === 'url');
  for (const phrase of phrases) {
    if (phrase.kind === 'note') notes.push(phrase.text);
  }

  const flow: BubblegumFlow | undefined =
    steps.length === 0
      ? undefined
      : {
          name: flowName(testCase.id),
          caseId: testCase.id,
          summary: testCase.title,
          steps,
        };

  return {
    ...(flow !== undefined ? { flow } : {}),
    test: {
      caseId: testCase.id,
      title: testCase.title,
      tags: testCase.tags,
      mode,
      goto,
      reuse,
      ...(flow !== undefined ? { flow: flow.name } : {}),
      checks,
      notes,
    },
  };
}

/**
 * How this case is emitted — the LOCKED precedence from the TestPlan schema,
 * with one addition this dialect needs.
 *
 * `blocked` and `prerequisites` behave exactly as in `playwright-pom`. The new
 * case is an ungrounded phrase: the plan named an element that is not in the
 * Screen Model, or one with nothing to call it by in a sentence. That has no
 * `playwright-pom` equivalent because there the compile gate catches it — a
 * missing locator will not build. Here the file compiles perfectly and fails as
 * a resolver timeout in CI, so the refusal has to happen at generation time.
 */
function modeFor(
  testCase: TestCase,
  ungrounded: Phrase[],
  dataNeedsGrounded: boolean,
): TestMode {
  if (testCase.status === 'blocked') {
    return { kind: 'fixme', reason: testCase.blockedReason ?? 'blocked by the planner' };
  }
  if (ungrounded.length > 0) {
    const reasons = ungrounded
      .map((p) => (p.kind === 'ungrounded' ? p.reason : ''))
      .filter((r) => r !== '');
    return { kind: 'fixme', reason: reasons.join('; ') };
  }
  const prerequisites = blockingPrerequisites(testCase, dataNeedsGrounded);
  if (prerequisites.length > 0) {
    return {
      kind: 'skip',
      reason: prerequisites.map((p) => `${p.kind}: ${p.description}`).join('; '),
    };
  }
  return { kind: 'live' };
}

function callFor(flow: FlowEntry, auth: { flow: FlowEntry; getter: string } | undefined): ReusedCall {
  // `engine` and `page` are positional in every flow this dialect writes and are
  // rendered by the caller, so only the remaining parameters need arguments.
  const extra = flow.params.filter((p) => p.name !== 'engine' && p.name !== 'page');
  const args =
    auth !== undefined && auth.flow.id === flow.id && extra.length === 1
      ? [`${auth.getter}()`]
      : extra.map((p) => `/* ${p.name}: ${p.type} */`);
  return {
    flowId: flow.id,
    exportName: flow.exportName,
    importPath: flow.file,
    args,
  };
}

/** `case-3` -> `case3Flow`; stable, and a valid identifier whatever the id is. */
export function flowName(caseId: string): string {
  const camel = caseId
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part !== '')
    .map((part, index) => (index === 0 ? part : part[0]!.toUpperCase() + part.slice(1)))
    .join('');
  const safe = /^[A-Za-z_$]/.test(camel) ? camel : `case${camel}`;
  return `${safe}Flow`;
}

/** Prerequisites that still stop a run, given what the knowledge base answered. */
function blockingPrerequisites(testCase: TestCase, dataNeedsGrounded: boolean) {
  const prerequisites = testCase.prerequisites ?? [];
  return dataNeedsGrounded ? prerequisites.filter((p) => p.kind !== 'data') : prerequisites;
}

/** Prerequisites the knowledge base already answered, kept as notes. */
function coveredPrerequisites(testCase: TestCase, dataNeedsGrounded: boolean): string[] {
  if (!dataNeedsGrounded) return [];
  return (testCase.prerequisites ?? [])
    .filter((p) => p.kind === 'data')
    .map((p) => p.description);
}
