import { describe, it, expect } from 'vitest';
import { emitBatch } from './batch.js';
import { playwrightPomDialect } from './dialects/playwright-pom.js';
import type { Element, Page, ScreenModel, SelectorCandidate } from '../schemas/screen-model.js';
import type { TestCase, TestPlan } from '../schemas/test-plan.js';

/**
 * The batch exists for one reason: `flint generate <feature>` gates each
 * feature against the suite as it currently stands, and in a full pipeline run
 * that is the wrong unit. Whichever feature goes first meets the others'
 * un-regenerated specs. These tests pin the properties that make batching a
 * fix rather than a reshuffle.
 */

function candidate(over: Partial<SelectorCandidate> = {}): SelectorCandidate {
  return {
    strategy: 'testid',
    value: '[data-test="x"]',
    score: 100,
    unique: true,
    verified: true,
    ...over,
  };
}

function element(id: string, name: string): Element {
  return {
    id,
    role: 'button',
    name,
    tagName: 'button',
    boundingBox: { x: 0, y: 0, width: 10, height: 10 },
    states: { visible: true, enabled: true },
    selectorCandidates: [candidate({ value: `[data-test="${id}"]` })],
  };
}

function page(id: string, urlPattern: string, elements: Element[]): Page {
  return {
    id,
    url: `https://shop.example.com${urlPattern}`,
    urlPattern,
    title: urlPattern,
    reachedVia: { kind: 'link', href: urlPattern },
    navTargets: [],
    capturedAt: '2026-01-01T00:00:00.000Z',
    elements,
  };
}

/** One page both features touch — the case that made ordering matter. */
const SHARED = page('p-home', '/', [element('el-login', 'Login'), element('el-cart', 'Cart')]);

const MODEL: ScreenModel = {
  version: 'model-1',
  baseUrl: 'https://shop.example.com',
  capturedAt: '2026-01-01T00:00:00.000Z',
  pages: [SHARED],
};

function testCase(id: string, title: string, elementId: string): TestCase {
  return {
    id,
    title,
    priority: 'p1',
    tags: [],
    status: 'new',
    steps: [
      { action: 'goto', value: 'https://shop.example.com/' },
      { action: 'click', elementRef: elementId },
      { action: 'assert', elementRef: elementId, assertion: { kind: 'visible', expected: true } },
    ],
  } as TestCase;
}

function plan(featureId: string, cases: TestCase[]): TestPlan {
  return {
    featureId,
    generatedAt: '2026-01-01T00:00:00.000Z',
    screenModelVersion: 'model-1',
    cases,
  };
}

function batch(features: Array<{ featureId: string; cases: TestCase[] }>) {
  return emitBatch({
    features: features.map((f) => ({
      featureId: f.featureId,
      plan: plan(f.featureId, f.cases),
      title: f.featureId,
    })),
    model: MODEL,
    dialect: playwrightPomDialect,
    existingPageObjects: [],
  });
}

const LOGIN = { featureId: 'login', cases: [testCase('c1', 'signs in', 'el-login')] };
const CART = { featureId: 'cart', cases: [testCase('c2', 'opens the cart', 'el-cart')] };

describe('emitBatch', () => {
  it('emits one file per path, not one per feature', () => {
    const result = batch([LOGIN, CART]);
    const paths = result.files.map((f) => f.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('gives the shared page object both features’ locators', () => {
    // The whole point. Per-feature emits produced a page object holding only
    // the current feature's locators, which is what broke the other feature's
    // spec at the compile gate.
    const result = batch([LOGIN, CART]);
    const home = result.files.find((f) => f.path.endsWith('.page.ts'));
    expect(home).toBeDefined();
    expect(home!.contents).toContain('el-login');
    expect(home!.contents).toContain('el-cart');
  });

  it('produces the same files whichever order the features arrive in', () => {
    // If order still mattered, batching would only have moved the problem.
    const forward = batch([LOGIN, CART]);
    const reverse = batch([CART, LOGIN]);
    expect(reverse.files.map((f) => f.path)).toEqual(forward.files.map((f) => f.path));
    const pageOf = (r: typeof forward) =>
      r.files.find((f) => f.path.endsWith('.page.ts'))!.contents;
    expect(pageOf(reverse)).toBe(pageOf(forward));
  });

  it('carries every feature’s spec file through', () => {
    const specs = batch([LOGIN, CART])
      .files.filter((f) => f.kind === 'spec')
      .map((f) => f.path);
    expect(specs).toHaveLength(2);
  });

  it('records the merged page-object state for a single write', () => {
    const result = batch([LOGIN, CART]);
    const home = result.pageObjectRecords.find((r) => r.pageId === 'p-home');
    expect(home?.elementIds.sort()).toEqual(['el-cart', 'el-login']);
    expect(home?.features.sort()).toEqual(['cart', 'login']);
  });

  it('reports per-feature results without collapsing them', () => {
    const result = batch([LOGIN, CART]);
    expect(result.perFeature.map((f) => f.featureId)).toEqual(['login', 'cart']);
    expect(result.perFeature.every((f) => f.liveTests === 1)).toBe(true);
  });

  it('names a feature whose plan is entirely duplicates', () => {
    // Not automatically the emergency `flint generate` refuses on: in a batch,
    // another feature may legitimately have taken the coverage over. The caller
    // decides with the whole batch in view.
    const result = batch([
      LOGIN,
      {
        featureId: 'dupe',
        cases: [
          {
            ...testCase('c3', 'signs in', 'el-login'),
            status: 'skipped-duplicate' as const,
            duplicateOf: 'signs in',
          },
        ],
      },
    ]);
    expect(result.fullyDuplicated).toEqual(['dupe']);
  });

  it('says nothing about a feature that has no cases at all', () => {
    // An empty plan is not a duplicate problem — there was nothing to take.
    const result = batch([{ featureId: 'empty', cases: [] }]);
    expect(result.fullyDuplicated).toEqual([]);
  });
});
