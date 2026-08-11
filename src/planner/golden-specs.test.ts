import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FakeProvider } from '../llm/index.js';
import { TestPlanSchema, type TestPlan } from '../schemas/test-plan.js';
import type { ScreenModel, Element } from '../schemas/screen-model.js';
import type { SuiteIndex } from '../schemas/suite-index.js';
import { readFeatureSpec } from './feature-spec.js';
import { generatePlan } from './planner.js';
import { renderPlan } from './plan-renderer.js';
import { buildContext } from './context-builder.js';

/**
 * Phase 3 exit criteria, exercised over five golden feature specs.
 *
 * The master plan asks for three properties: plans reference only real Element
 * ids, cover every acceptance criterion, and skip what a pre-seeded suite
 * already covers. Each is asserted below against a fixed Screen Model, with the
 * LLM replaced by a deterministic responder — so a failure means the pipeline
 * broke, never that a model had an off day.
 *
 * The responder is not a stub that returns a fixed blob: it reads the prompt it
 * is given, extracts the element ids the context offered, and plans against
 * them. That is what makes "references only real ids" a real assertion — a bug
 * that stopped ids reaching the prompt would show up as an empty plan.
 */

let root: string;

// --- the app being planned against ----------------------------------------

function element(id: string, role: string, name: string, extra: Partial<Element> = {}): Element {
  return {
    id,
    role,
    name,
    tagName: role === 'button' ? 'button' : 'input',
    boundingBox: { x: 0, y: 0, width: 10, height: 10 },
    states: { visible: true, enabled: true },
    selectorCandidates: [
      {
        strategy: 'testid',
        value: `[data-testid="${id}"]`,
        score: 100,
        unique: true,
        verified: true,
      },
    ],
    ...extra,
  };
}

const MODEL: ScreenModel = {
  version: 'model-1',
  baseUrl: 'https://shop.example.com',
  capturedAt: '2026-01-01T00:00:00.000Z',
  pages: [
    {
      id: 'page-login',
      url: 'https://shop.example.com/login',
      urlPattern: '/login',
      title: 'Sign in',
      reachedVia: { kind: 'link', href: '/login' },
      navTargets: [],
      capturedAt: '2026-01-01T00:00:00.000Z',
      elements: [
        element('el-username', 'textbox', 'Username'),
        element('el-password', 'textbox', 'Password'),
        element('el-login', 'button', 'Login'),
        element('el-login-error', 'alert', 'Error message'),
      ],
    },
    {
      id: 'page-cart',
      url: 'https://shop.example.com/cart',
      urlPattern: '/cart',
      title: 'Cart',
      reachedVia: { kind: 'link', href: '/cart' },
      navTargets: [],
      capturedAt: '2026-01-01T00:00:00.000Z',
      elements: [
        element('el-checkout', 'button', 'Checkout'),
        // Only exists once a flow has populated the cart.
        element('el-remove', 'button', 'Remove', {
          provenance: { kind: 'flow', flowId: 'populated-cart', step: 0 },
        }),
        // Only exists after opening the account menu.
        element('el-signout', 'menuitem', 'Sign out', {
          provenance: { kind: 'revealed', openerElementId: 'el-checkout' },
        }),
      ],
    },
  ],
};

/** A suite that already covers logging in — the duplicate-detection fixture. */
const SEEDED_INDEX: SuiteIndex = {
  generatedAt: '2026-01-01T00:00:00.000Z',
  suiteDir: 'e2e',
  pageObjects: [],
  specs: [
    { file: 'e2e/tests/login.spec.ts', testTitles: ['User can sign in'], tags: ['@feature:login'] },
  ],
  fixtures: [],
  dataFactories: [],
  coverageMap: { login: ['User can sign in'] },
  managedFiles: [],
  handEditedFiles: [],
};

// --- the five golden specs -------------------------------------------------

const GOLDEN: Array<{ id: string; source: string }> = [
  {
    id: 'login',
    source: `---
id: login
title: Sign in
priority: p0
pages: ['/login']
acceptanceCriteria:
  - A user with valid credentials reaches the inventory page
  - A user with an invalid password sees an error
negativeCases:
  - Locked-out user is refused
---
Users sign in with a username and password.`,
  },
  {
    id: 'cart',
    source: `---
id: cart
title: Cart management
priority: p1
pages: ['/cart']
acceptanceCriteria:
  - A user can proceed to checkout from the cart
---
The cart lists items and offers checkout.`,
  },
  {
    id: 'reporting',
    source: `---
id: reporting
title: Export reports
priority: p2
acceptanceCriteria:
  - A user can export the sales report as CSV
---
There is a reporting screen with an export button.`,
  },
  {
    id: 'vague',
    source: `---
id: vague
title: Improve the checkout
priority: p0
pages: ['/cart']
---
Make checkout better.`,
  },
  {
    id: 'multi-page',
    source: `---
id: multi-page
title: Sign in then check out
priority: p1
pages: ['/login', '/cart']
acceptanceCriteria:
  - A signed-in user can complete a purchase
dataNeeds:
  - A user account with a populated cart
---
Covers the journey across the sign-in and cart screens.`,
  },
];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'flint-golden-'));
  for (const spec of GOLDEN) {
    const path = join(root, 'kb', 'features', `${spec.id}.md`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, spec.source, 'utf8');
  }
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

/**
 * A responder that plans from the prompt it was given.
 *
 * It parses the element ids out of the rendered context and builds a plan that
 * uses them — mimicking a well-behaved planner without needing a model.
 */
function planningResponder(options: { misbehave?: 'invent-element' | 'bad-json' } = {}) {
  return (input: { payload: unknown }): { text: string } => {
    // FakeProvider passes the prompt string straight through as the payload.
    const prompt = typeof input.payload === 'string' ? input.payload : '';
    if (options.misbehave === 'bad-json') return { text: 'I think the plan should be...' };

    // A real planner blocks when the context admits nothing matched; mirror
    // that here rather than mapping the spec onto unrelated elements.
    const noPageMatched = prompt.includes('**No page matched this feature.**');
    const ids = noPageMatched ? [] : [...prompt.matchAll(/^- (el-[\w-]+) —/gm)].map((m) => m[1]!);
    const featureId = /^- id: ([\w-]+)$/m.exec(prompt)?.[1] ?? 'unknown';
    const criteria = [...prompt.matchAll(/^- (AC\d+):/gm)].map((m) => m[1]!);

    const elementRef = options.misbehave === 'invent-element' ? 'el-invented' : (ids[0] ?? 'el-x');

    const cases =
      ids.length === 0
        ? [
            {
              id: 'blocked-1',
              title: `${featureId} is not reachable`,
              priority: 'p1',
              tags: ['@flint', `@feature:${featureId}`],
              status: 'blocked',
              blockedReason: 'element not found in exploration — re-explore or add flow script',
              acceptanceRefs: criteria,
              steps: [],
            },
          ]
        : criteria.map((ac, i) => ({
            id: `case-${i + 1}`,
            title: `${featureId} behaviour ${i + 1}`,
            priority: 'p1',
            tags: ['@flint', `@feature:${featureId}`],
            status: 'new',
            acceptanceRefs: [ac],
            steps: [
              { action: 'goto', value: '/' },
              { action: 'click', elementRef },
              {
                action: 'assert',
                elementRef,
                assertion: { kind: 'visible', expected: true },
              },
            ],
          }));

    return {
      text: JSON.stringify({
        featureId,
        generatedAt: '2026-01-01T00:00:00.000Z',
        screenModelVersion: 'model-1',
        cases: cases.length > 0 ? cases : [],
        openQuestions: criteria.length === 0 ? ['What does "better" mean here?'] : [],
      }),
    };
  };
}

async function planFor(featureId: string, index?: SuiteIndex, misbehave?: 'invent-element') {
  const spec = readFeatureSpec(root, 'kb', featureId);
  return generatePlan({
    spec,
    model: MODEL,
    provider: new FakeProvider({
      responder: planningResponder(misbehave === undefined ? {} : { misbehave }),
    }),
    modelId: 'fake-planner',
    tokenBudget: 60_000,
    ...(index !== undefined ? { index } : {}),
  });
}

describe('Phase 3 exit criteria — golden feature specs', () => {
  it('produces a schema-valid plan for every golden spec', async () => {
    for (const { id } of GOLDEN) {
      const result = await planFor(id);
      expect(TestPlanSchema.safeParse(result.plan).success, `spec ${id}`).toBe(true);
    }
  });

  it('references only element ids that exist in the Screen Model', async () => {
    const allIds = new Set(MODEL.pages.flatMap((p) => p.elements.map((e) => e.id)));
    for (const { id } of GOLDEN) {
      const result = await planFor(id);
      for (const testCase of result.plan.cases) {
        if (testCase.status === 'blocked') continue;
        for (const step of testCase.steps) {
          if (step.elementRef === undefined) continue;
          expect(allIds.has(step.elementRef), `${id}/${testCase.id}`).toBe(true);
        }
      }
    }
  });

  it('refuses a plan that invents an element rather than returning it', async () => {
    // The single most important guarantee in this phase.
    await expect(planFor('login', undefined, 'invent-element')).rejects.toThrow(
      /references elements that do not exist/,
    );
  });

  it('covers every acceptance criterion the spec declares', async () => {
    for (const { id } of GOLDEN) {
      const spec = readFeatureSpec(root, 'kb', id);
      const criteria = spec.frontmatter.acceptanceCriteria ?? [];
      if (criteria.length === 0) continue;

      const result = await planFor(id);
      const referenced = new Set(result.plan.cases.flatMap((c) => c.acceptanceRefs ?? []));
      criteria.forEach((_, i) => {
        expect(referenced.has(`AC${i + 1}`), `${id} AC${i + 1}`).toBe(true);
      });
    }
  });

  it('blocks rather than invents when the spec needs UI that was never explored', async () => {
    // `reporting` asks for an export button; no page in the model has one, and
    // the spec gives no `pages:` hint that matches.
    const result = await planFor('reporting');
    const blocked = result.plan.cases.filter((c) => c.status === 'blocked');
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked[0]!.blockedReason).toMatch(/not found in exploration/);
  });

  it('asks a question instead of guessing on a vague spec', async () => {
    const result = await planFor('vague');
    expect(result.plan.openQuestions ?? []).not.toHaveLength(0);
  });

  it('skips what the pre-seeded suite already covers', async () => {
    // The responder titles cases "<feature> behaviour N"; seed a matching title
    // so the deterministic post-check has something to catch.
    const seeded: SuiteIndex = {
      ...SEEDED_INDEX,
      coverageMap: { login: ['login behaviour 1'] },
    };
    const result = await planFor('login', seeded);
    const duplicates = result.plan.cases.filter((c) => c.status === 'skipped-duplicate');
    expect(duplicates.length).toBeGreaterThan(0);
    expect(duplicates[0]!.duplicateOf).toBe('login behaviour 1');
    expect(result.forcedDuplicates.length).toBeGreaterThan(0);
  });

  it('does not skip a case the suite has never covered', async () => {
    const result = await planFor('cart', SEEDED_INDEX);
    expect(result.plan.cases.every((c) => c.status !== 'skipped-duplicate')).toBe(true);
  });

  it('retries once when the model returns unusable output, then gives up loudly', async () => {
    const spec = readFeatureSpec(root, 'kb', 'login');
    await expect(
      generatePlan({
        spec,
        model: MODEL,
        provider: new FakeProvider({ responder: planningResponder({ misbehave: 'bad-json' }) }),
        modelId: 'fake-planner',
        tokenBudget: 60_000,
      }),
    ).rejects.toThrow(/after two attempts/);
  });

  it('renders a plan whose checklist shows the covered criteria', async () => {
    const spec = readFeatureSpec(root, 'kb', 'login');
    const result = await planFor('login');
    const markdown = renderPlan({ plan: result.plan, spec });
    expect(markdown).toMatch(/## Acceptance coverage/);
    expect(markdown).toMatch(/- \[x\] \*\*AC1\*\*/);
    expect(markdown).toMatch(/## Cases/);
  });

  it('warns in the rendered plan when a criterion has no case', async () => {
    const spec = readFeatureSpec(root, 'kb', 'login');
    const stripped: TestPlan = {
      ...(await planFor('login')).plan,
      cases: [],
    };
    const markdown = renderPlan({ plan: stripped, spec });
    expect(markdown).toMatch(/- \[ \] \*\*AC1\*\*/);
    expect(markdown).toMatch(/acceptance criterion\/criteria have no case/);
  });
});

describe('context grounding', () => {
  it('tells the planner the precondition for interaction- and flow-revealed elements', () => {
    const spec = readFeatureSpec(root, 'kb', 'cart');
    const context = buildContext({ spec, model: MODEL, tokenBudget: 60_000 });
    expect(context.text).toContain('only exists in the state produced by flow "populated-cart"');
    expect(context.text).toContain('only exists after clicking element el-checkout');
  });

  it('omits elements with no verified-unique selector, which Phase 4 could not emit', () => {
    const unusable: ScreenModel = {
      ...MODEL,
      pages: [
        {
          ...MODEL.pages[1]!,
          elements: [
            element('el-usable', 'button', 'Usable'),
            {
              ...element('el-unusable', 'button', 'Unusable'),
              selectorCandidates: [
                { strategy: 'css', value: 'div', score: 9, unique: false, verified: true },
              ],
            },
          ],
        },
      ],
    };
    const spec = readFeatureSpec(root, 'kb', 'cart');
    const context = buildContext({ spec, model: unusable, tokenBudget: 60_000 });
    expect(context.allowedElementIds.has('el-usable')).toBe(true);
    expect(context.allowedElementIds.has('el-unusable')).toBe(false);
    expect(context.text).not.toContain('el-unusable');
  });

  it('drops exemplars before pages when the budget is tight', () => {
    const spec = readFeatureSpec(root, 'kb', 'multi-page');
    const context = buildContext({
      spec,
      model: MODEL,
      tokenBudget: 400,
      index: SEEDED_INDEX,
      conventions: 'Use page objects.',
      exemplars: [{ path: 'e2e/a.spec.ts', contents: 'x'.repeat(4000) }],
    });
    expect(context.dropped).toContain('exemplars');
    // The spec itself is never dropped.
    expect(context.text).toContain('## Feature specification');
  });

  it('keeps at least one page however small the budget', () => {
    const spec = readFeatureSpec(root, 'kb', 'multi-page');
    const context = buildContext({ spec, model: MODEL, tokenBudget: 1 });
    expect(context.pages).toHaveLength(1);
  });
});
