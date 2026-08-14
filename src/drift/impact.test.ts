import { describe, it, expect } from 'vitest';
import { analyzeDrift, breakingTests, formatImpact } from './impact.js';
import { diffModels } from '../explorer/screen-model-store.js';
import type { Element, Page, ScreenModel } from '../schemas/screen-model.js';
import type { SuiteIndex } from '../schemas/suite-index.js';
import type { StoredPageObject } from '../generator/page-object-store.js';

/**
 * Drift mode's job is to turn "17 element ids changed" into "these 3 tests
 * break". These tests pin the two things that makes worth reading: it must not
 * miss a break, and it must not cry wolf.
 */

function element(id: string, over: Partial<Element> = {}): Element {
  return {
    id,
    role: 'button',
    name: 'Add to cart',
    tagName: 'button',
    boundingBox: { x: 0, y: 0, width: 10, height: 10 },
    states: { visible: true, enabled: true },
    selectorCandidates: [
      {
        strategy: 'testid',
        value: `[data-test="${id}"]`,
        score: 100,
        unique: true,
        verified: true,
      },
      {
        strategy: 'role',
        value: 'button[name="Add to cart"]',
        score: 85,
        unique: true,
        verified: true,
      },
    ],
    ...over,
  };
}

function model(elements: Element[], pageId = 'p-inventory'): ScreenModel {
  const page: Page = {
    id: pageId,
    url: 'https://shop.example.com/inventory',
    urlPattern: '/inventory',
    title: 'Inventory',
    reachedVia: { kind: 'link', href: '/inventory' },
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

const INDEX: SuiteIndex = {
  generatedAt: '2026-01-01T00:00:00.000Z',
  suiteDir: 'e2e',
  pageObjects: [
    {
      className: 'InventoryPage',
      file: 'e2e/pages/inventory.page.ts',
      methods: [],
      selectorsUsed: ['[data-test="el-add"]'],
    },
  ],
  specs: [
    {
      file: 'e2e/tests/cart.spec.ts',
      testTitles: ['adds an item to the cart @flint @feature:cart'],
      tags: ['@feature:cart', '@flint'],
    },
  ],
  fixtures: [],
  dataFactories: [],
  coverageMap: { cart: ['adds an item to the cart @flint @feature:cart'] },
  managedFiles: ['e2e/pages/inventory.page.ts', 'e2e/tests/cart.spec.ts'],
  handEditedFiles: [],
};

const RECORDS: StoredPageObject[] = [
  {
    className: 'InventoryPage',
    pageId: 'p-inventory',
    features: ['cart'],
    elementIds: ['el-add'],
    actions: [{ kind: 'click', elementId: 'el-add' }],
  },
];

function analyze(
  before: ScreenModel,
  after: ScreenModel,
  over: Partial<Parameters<typeof analyzeDrift>[0]> = {},
) {
  return analyzeDrift({
    diff: diffModels(before, after),
    before,
    index: INDEX,
    records: RECORDS,
    ...over,
  });
}

describe('analyzeDrift', () => {
  it('names the tests a removed element breaks', () => {
    const impact = analyze(model([element('el-add')]), model([]));
    expect(breakingTests(impact).map((t) => t.testId)).toEqual([
      'adds an item to the cart @flint @feature:cart',
    ]);
    expect(impact.affectedTests[0]?.file).toBe('e2e/tests/cart.spec.ts');
    expect(impact.affectedTests[0]?.through).toEqual(['InventoryPage']);
  });

  it('calls a lost selector the suite actually uses a break', () => {
    const before = model([element('el-add')]);
    const after = model([
      element('el-add', {
        selectorCandidates: [
          {
            strategy: 'role',
            value: 'button[name="Add to cart"]',
            score: 85,
            unique: true,
            verified: true,
          },
        ],
      }),
    ]);
    const impact = analyze(before, after);
    expect(impact.affectedPageObjects[0]?.severity).toBe('breaks');
    expect(breakingTests(impact)).toHaveLength(1);
  });

  it('downgrades a lost selector the page object does not use', () => {
    // The element dropped its test id, but this suite addresses it some other
    // way. Saying "will break" here is how a report stops being read.
    const index: SuiteIndex = {
      ...INDEX,
      pageObjects: [{ ...INDEX.pageObjects[0]!, selectorsUsed: ['#add-to-cart'] }],
    };
    const before = model([element('el-add')]);
    const after = model([
      element('el-add', {
        selectorCandidates: [
          {
            strategy: 'role',
            value: 'button[name="Add to cart"]',
            score: 85,
            unique: true,
            verified: true,
          },
        ],
      }),
    ]);
    const impact = analyze(before, after, { index });
    expect(impact.affectedPageObjects[0]?.severity).toBe('likely');
    expect(breakingTests(impact)).toHaveLength(0);
    expect(impact.affectedTests).toHaveLength(1);
  });

  it('treats a renamed element as likely, not certain', () => {
    const before = model([element('el-add')]);
    const after = model([element('el-add', { name: 'Add item' })]);
    const impact = analyze(before, after);
    expect(impact.drift[0]?.kind).toBe('identity-changed');
    expect(impact.affectedTests[0]?.severity).toBe('likely');
  });

  it('treats a state flip as possible only', () => {
    const before = model([element('el-add')]);
    const after = model([element('el-add', { states: { visible: false, enabled: true } })]);
    const impact = analyze(before, after);
    expect(impact.drift[0]?.kind).toBe('state-changed');
    expect(impact.affectedTests[0]?.severity).toBe('possible');
  });

  it('ignores a change that only adds a selector', () => {
    const before = model([element('el-add')]);
    const after = model([
      element('el-add', {
        selectorCandidates: [
          ...element('el-add').selectorCandidates,
          { strategy: 'text', value: 'Add to cart', score: 55, unique: true, verified: true },
        ],
      }),
    ]);
    const impact = analyze(before, after);
    expect(impact.drift).toEqual([]);
    expect(impact.affectedTests).toEqual([]);
  });

  it('finds a hand-written page object through its selector string', () => {
    // No record for this class — Flint never generated it. The Suite Index's
    // recorded selector strings are the only link, and they are enough.
    const index: SuiteIndex = {
      ...INDEX,
      pageObjects: [
        ...INDEX.pageObjects,
        {
          className: 'LegacyCartPage',
          file: 'e2e/legacy/cart.page.ts',
          methods: [],
          selectorsUsed: ['[data-test="el-add"]'],
        },
      ],
    };
    const impact = analyze(model([element('el-add')]), model([]), { index });
    const classes = impact.affectedPageObjects.map((p) => p.className);
    expect(classes).toContain('LegacyCartPage');
    expect(impact.affectedPageObjects.find((p) => p.className === 'LegacyCartPage')?.via).toEqual([
      'selector',
    ]);
  });

  it('does not match on a bare role string', () => {
    // `getByRole('button', …)` records `button` as its first argument. Treating
    // that as a match would flag every button in the suite.
    const index: SuiteIndex = {
      ...INDEX,
      pageObjects: [
        {
          className: 'SomeOtherPage',
          file: 'e2e/pages/other.page.ts',
          methods: [],
          selectorsUsed: ['button', 'button[name="Add to cart"]'],
        },
      ],
    };
    const impact = analyze(model([element('el-add')]), model([]), { index, records: [] });
    expect(impact.affectedPageObjects).toEqual([]);
    expect(impact.unmapped).toHaveLength(1);
  });

  it('separates changes nothing in the suite addresses', () => {
    const impact = analyze(model([element('el-orphan')]), model([]));
    expect(impact.affectedTests).toEqual([]);
    expect(impact.unmapped.map((d) => d.elementId)).toEqual(['el-orphan']);
  });

  it('reports new elements as coverage, never as breakage', () => {
    const impact = analyze(
      model([element('el-add')]),
      model([element('el-add'), element('el-new')]),
    );
    expect(impact.newElements).toEqual([{ pageId: 'p-inventory', elementId: 'el-new' }]);
    expect(impact.affectedTests).toEqual([]);
  });

  it('expands a removed page into the elements that lived on it', () => {
    const before = model([element('el-add')], 'p-inventory');
    const after: ScreenModel = { ...before, pages: [] };
    const impact = analyze(before, after);
    expect(impact.removedPages).toEqual(['p-inventory']);
    expect(breakingTests(impact)).toHaveLength(1);
  });

  it('is stable: worst first, then by name', () => {
    const before = model([element('el-add'), element('el-zzz'), element('el-mmm')]);
    const after = model([
      element('el-zzz', { name: 'renamed' }),
      element('el-mmm', { states: { visible: false, enabled: true } }),
    ]);
    const impact = analyze(before, after);
    expect(impact.drift.map((d) => d.severity)).toEqual(['breaks', 'likely', 'possible']);
  });
});

describe('formatImpact', () => {
  it('leads with the number of tests that break', () => {
    const text = formatImpact(analyze(model([element('el-add')]), model([])));
    expect(text.split('\n')[0]).toContain('1 test(s) will break');
    expect(text).toContain('e2e/tests/cart.spec.ts');
  });

  it('says so plainly when nothing in the suite is affected', () => {
    const text = formatImpact(analyze(model([element('el-orphan')]), model([])));
    expect(text).toContain('no test in the suite addresses anything that changed');
  });
});
