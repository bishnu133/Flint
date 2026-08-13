import { describe, it, expect } from 'vitest';
import { regeneratePageObjects } from './regenerate.js';
import { playwrightPomDialect } from '../generator/dialects/playwright-pom.js';
import type { Element, Page, ScreenModel, SelectorCandidate } from '../schemas/screen-model.js';
import type { TestCase, TestPlan } from '../schemas/test-plan.js';

/**
 * The contract drift repair rests on: page objects are re-emitted from the new
 * model, specs are never touched, and a locator that cannot be re-emitted is
 * reported rather than silently dropped.
 */

function candidate(value: string, over: Partial<SelectorCandidate> = {}): SelectorCandidate {
  return { strategy: 'testid', value, score: 100, unique: true, verified: true, ...over };
}

function element(id: string, testIdValue = id): Element {
  return {
    id,
    role: 'button',
    name: id,
    tagName: 'button',
    boundingBox: { x: 0, y: 0, width: 10, height: 10 },
    states: { visible: true, enabled: true },
    selectorCandidates: [candidate(`[data-test="${testIdValue}"]`)],
  };
}

function model(elements: Element[]): ScreenModel {
  const page: Page = {
    id: 'p-home',
    url: 'https://shop.example.com/',
    urlPattern: '/',
    title: 'Home',
    reachedVia: { kind: 'link', href: '/' },
    navTargets: [],
    capturedAt: '2026-01-01T00:00:00.000Z',
    elements,
  };
  return {
    version: 'model-1',
    baseUrl: 'https://shop.example.com',
    capturedAt: '2026-01-01T00:00:00.000Z',
    pages: [page],
  };
}

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

const FEATURES = [
  {
    featureId: 'login',
    plan: plan('login', [testCase('c1', 'signs in', 'el-login')]),
    title: 'Login',
  },
];

describe('regeneratePageObjects', () => {
  it('emits page objects and no specs', () => {
    const result = regeneratePageObjects({
      features: FEATURES,
      model: model([element('el-login')]),
      dialect: playwrightPomDialect,
      existingPageObjects: [],
    });
    expect(result.files.every((f) => f.kind === 'page-object')).toBe(true);
    expect(result.files.length).toBeGreaterThan(0);
  });

  it('re-points a locator whose selector the app renamed', () => {
    const result = regeneratePageObjects({
      features: FEATURES,
      // Same element id, new test-id value: exactly the drift this repairs.
      model: model([element('el-login', 'sign-in-button')]),
      dialect: playwrightPomDialect,
      existingPageObjects: [
        {
          className: 'HomePage',
          pageId: 'p-home',
          features: ['login'],
          elementIds: ['el-login'],
          actions: [{ kind: 'click', elementId: 'el-login' }],
        },
      ],
    });
    const contents = result.files[0]!.contents;
    expect(contents).toContain('[data-test="sign-in-button"]');
    expect(contents).not.toContain('[data-test="el-login"]');
  });

  it('reports a locator the new model can no longer address', () => {
    // `el-login` is gone from the app. login.spec.ts still calls it and is not
    // being rewritten, so the caller must gate and refuse — this is the
    // evidence for saying why.
    const result = regeneratePageObjects({
      features: [
        ...FEATURES,
        {
          featureId: 'cart',
          plan: plan('cart', [testCase('c2', 'opens cart', 'el-cart')]),
          title: 'Cart',
        },
      ],
      model: model([element('el-cart')]),
      dialect: playwrightPomDialect,
      existingPageObjects: [
        {
          className: 'HomePage',
          pageId: 'p-home',
          features: ['cart', 'login'],
          elementIds: ['el-cart', 'el-login'],
          actions: [],
        },
      ],
    });
    expect(result.staleLocators).toHaveLength(1);
    expect(result.staleLocators[0]?.elementIds).toEqual(['el-login']);
    expect(result.staleLocators[0]?.features).toEqual(['login']);
  });

  it('keeps every feature’s locators on a shared page object', () => {
    const result = regeneratePageObjects({
      features: [
        ...FEATURES,
        {
          featureId: 'cart',
          plan: plan('cart', [testCase('c2', 'opens cart', 'el-cart')]),
          title: 'Cart',
        },
      ],
      model: model([element('el-login'), element('el-cart')]),
      dialect: playwrightPomDialect,
      existingPageObjects: [],
    });
    const contents = result.files.map((f) => f.contents).join('\n');
    expect(contents).toContain('el-login');
    expect(contents).toContain('el-cart');
    expect(result.pageObjectRecords[0]?.features.sort()).toEqual(['cart', 'login']);
  });
});
