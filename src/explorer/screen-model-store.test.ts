import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalize,
  writeModel,
  readModel,
  tryReadModel,
  diffModels,
  formatDiff,
  modelPath,
} from './screen-model-store.js';
import type { Element, Page, ScreenModel } from '../schemas/screen-model.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flint-sm-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function element(id: string, overrides: Partial<Element> = {}): Element {
  return {
    id,
    role: 'button',
    name: 'Go',
    tagName: 'button',
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
    ...overrides,
  };
}

function page(id: string, elements: Element[] = [], overrides: Partial<Page> = {}): Page {
  return {
    id,
    url: `https://app.example.com/${id}`,
    urlPattern: `/${id}`,
    title: id,
    reachedVia: { kind: 'link', href: `/${id}` },
    elements,
    navTargets: [],
    capturedAt: '2026-08-10T00:00:00.000Z',
    ...overrides,
  };
}

function model(pages: Page[]): ScreenModel {
  return {
    version: '1',
    baseUrl: 'https://app.example.com',
    capturedAt: '2026-08-10T00:00:00.000Z',
    pages,
  };
}

describe('modelPath', () => {
  it('uses model.json by default', () => {
    expect(modelPath('/proj')).toContain(join('.flint', 'screen-model', 'model.json'));
  });

  it('scopes by role when multi-role exploration is configured', () => {
    expect(modelPath('/proj', 'admin')).toContain('model.admin.json');
  });
});

describe('canonicalize', () => {
  it('sorts pages, elements, and navTargets', () => {
    const m = model([
      page('z', [element('b'), element('a')], { navTargets: ['/z', '/a'] }),
      page('a'),
    ]);
    const c = canonicalize(m);
    expect(c.pages.map((p) => p.id)).toEqual(['a', 'z']);
    expect(c.pages[1]?.elements.map((e) => e.id)).toEqual(['a', 'b']);
    expect(c.pages[1]?.navTargets).toEqual(['/a', '/z']);
  });

  it('sorts selector candidates by score descending', () => {
    const el = element('a', {
      selectorCandidates: [
        { strategy: 'css', value: 'div', score: 30, unique: true, verified: true },
        { strategy: 'testid', value: '[x]', score: 100, unique: true, verified: true },
      ],
    });
    const c = canonicalize(model([page('p', [el])]));
    expect(c.pages[0]?.elements[0]?.selectorCandidates.map((s) => s.strategy)).toEqual([
      'testid',
      'css',
    ]);
  });

  it('does not mutate the input', () => {
    const m = model([page('z'), page('a')]);
    canonicalize(m);
    expect(m.pages.map((p) => p.id)).toEqual(['z', 'a']);
  });
});

describe('writeModel / readModel', () => {
  it('round-trips a model', () => {
    const path = join(dir, 'model.json');
    const m = model([page('home', [element('btn')])]);
    writeModel(path, m);
    expect(readModel(path).pages[0]?.elements[0]?.id).toBe('btn');
  });

  it('creates parent directories', () => {
    const path = join(dir, 'nested', 'deep', 'model.json');
    writeModel(path, model([]));
    expect(readModel(path).pages).toEqual([]);
  });

  it('is byte-identical for models differing only in ordering', () => {
    const a = join(dir, 'a.json');
    const b = join(dir, 'b.json');
    writeModel(a, model([page('z', [element('b'), element('a')]), page('a')]));
    writeModel(b, model([page('a'), page('z', [element('a'), element('b')])]));
    expect(readFileSync(a, 'utf8')).toBe(readFileSync(b, 'utf8'));
  });

  it('errors actionably when the file is missing', () => {
    expect(() => readModel(join(dir, 'nope.json'))).toThrow(/No Screen Model/);
  });

  it('errors actionably on malformed JSON', () => {
    const path = join(dir, 'bad.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, '{not json', 'utf8');
    expect(() => readModel(path)).toThrow(/not valid JSON/);
  });

  it('errors actionably when the shape fails schema validation', () => {
    const path = join(dir, 'invalid.json');
    writeFileSync(path, JSON.stringify({ version: '1', pages: [] }), 'utf8');
    expect(() => readModel(path)).toThrow(/failed validation/);
  });
});

describe('tryReadModel', () => {
  it('returns undefined on first run rather than throwing', () => {
    expect(tryReadModel(join(dir, 'missing.json'))).toBeUndefined();
  });

  it('returns the model when present', () => {
    const path = join(dir, 'model.json');
    writeModel(path, model([page('home')]));
    expect(tryReadModel(path)?.pages).toHaveLength(1);
  });
});

describe('diffModels', () => {
  it('reports no changes for identical models', () => {
    const m = model([page('home', [element('btn')])]);
    const d = diffModels(m, m);
    expect(d.unchanged).toBe(true);
    expect(formatDiff(d)).toBe('No changes.');
  });

  it('detects an added page', () => {
    const d = diffModels(model([page('home')]), model([page('home'), page('cart')]));
    expect(d.addedPages).toEqual(['cart']);
    expect(d.unchanged).toBe(false);
  });

  it('detects a removed page', () => {
    const d = diffModels(model([page('home'), page('cart')]), model([page('home')]));
    expect(d.removedPages).toEqual(['cart']);
  });

  it('detects added and removed elements on a shared page', () => {
    const d = diffModels(
      model([page('home', [element('a'), element('b')])]),
      model([page('home', [element('a'), element('c')])]),
    );
    expect(d.changedPages[0]?.addedElements).toEqual(['c']);
    expect(d.changedPages[0]?.removedElements).toEqual(['b']);
  });

  it('names which fields of an element changed', () => {
    const d = diffModels(
      model([page('home', [element('a', { name: 'Old' })])]),
      model([page('home', [element('a', { name: 'New' })])]),
    );
    expect(d.changedPages[0]?.changedElements[0]).toEqual({
      elementId: 'a',
      changed: ['name'],
    });
  });

  it('flags a selector change — this is what Phase 6 maps to at-risk tests', () => {
    const before = element('a');
    const after = element('a', {
      selectorCandidates: [
        { strategy: 'css', value: 'div.new', score: 30, unique: true, verified: true },
      ],
    });
    const d = diffModels(model([page('home', [before])]), model([page('home', [after])]));
    expect(d.changedPages[0]?.changedElements[0]?.changed).toContain('selectorCandidates');
  });

  it('ignores boundingBox jitter, which is not drift', () => {
    const d = diffModels(
      model([page('home', [element('a', { boundingBox: { x: 0, y: 0, width: 10, height: 10 } })])]),
      model([page('home', [element('a', { boundingBox: { x: 3, y: 7, width: 11, height: 10 } })])]),
    );
    expect(d.unchanged).toBe(true);
  });

  it('detects a visibility change', () => {
    const d = diffModels(
      model([page('home', [element('a')])]),
      model([page('home', [element('a', { states: { visible: false, enabled: true } })])]),
    );
    expect(d.changedPages[0]?.changedElements[0]?.changed).toContain('states');
  });

  it('omits pages that did not change', () => {
    const d = diffModels(
      model([page('home', [element('a')]), page('cart', [element('x')])]),
      model([page('home', [element('a')]), page('cart', [element('y')])]),
    );
    expect(d.changedPages.map((p) => p.pageId)).toEqual(['cart']);
  });
});

describe('formatDiff', () => {
  it('renders adds, removes, and field-level changes', () => {
    const d = diffModels(
      model([page('home', [element('a', { name: 'Old' })]), page('gone')]),
      model([page('home', [element('a', { name: 'New' }), element('b')]), page('fresh')]),
    );
    const out = formatDiff(d);
    expect(out).toMatch(/\+ page\s+fresh/);
    expect(out).toMatch(/- page\s+gone/);
    expect(out).toMatch(/~ page\s+home/);
    expect(out).toMatch(/\+ element b/);
    expect(out).toMatch(/~ element a \[name\]/);
  });
});
