import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  mergePageObjectRecords,
  pageObjectRecordPath,
  readPageObjectRecords,
  writePageObjectRecords,
  type StoredPageObject,
  pruneToModel,
} from './page-object-store.js';
import { FlintError } from '../shared/errors.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'flint-po-store-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function record(over: Partial<StoredPageObject> = {}): StoredPageObject {
  return {
    className: 'HomePage',
    pageId: 'p1',
    features: ['login'],
    elementIds: ['el-login'],
    actions: [{ kind: 'click', elementId: 'el-login' }],
    ...over,
  };
}

describe('read/write', () => {
  it('returns nothing before anything has been generated', () => {
    expect(readPageObjectRecords(root)).toEqual([]);
  });

  it('round-trips', () => {
    writePageObjectRecords(root, [record()]);
    expect(readPageObjectRecords(root)).toEqual([record()]);
  });

  it('writes a stable file, sorted by page id', () => {
    writePageObjectRecords(root, [record({ pageId: 'p2' }), record({ pageId: 'p1' })]);
    expect(readPageObjectRecords(root).map((r) => r.pageId)).toEqual(['p1', 'p2']);
  });

  it('errors actionably on a corrupt record rather than silently starting over', () => {
    // Silently ignoring it would drop every locator earlier features added and
    // break their specs on the next generate — the exact failure this file
    // exists to prevent.
    const path = pageObjectRecordPath(root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{ not json', 'utf8');
    expect(() => readPageObjectRecords(root)).toThrowError(FlintError);
    expect(() => readPageObjectRecords(root)).toThrow(/not valid JSON/);
  });

  it('errors actionably when the record does not match its schema', () => {
    const path = pageObjectRecordPath(root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, pageObjects: [{ className: 'X' }] }), 'utf8');
    expect(() => readPageObjectRecords(root)).toThrow(/pageId/);
  });
});

describe('mergePageObjectRecords', () => {
  it('unions two features touching the same page', () => {
    const merged = mergePageObjectRecords(
      [record()],
      [
        record({
          features: ['search'],
          elementIds: ['el-search'],
          actions: [{ kind: 'click', elementId: 'el-search' }],
        }),
      ],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.features).toEqual(['login', 'search']);
    expect(merged[0]?.elementIds).toEqual(['el-login', 'el-search']);
    expect(merged[0]?.actions).toHaveLength(2);
  });

  it('keeps records for pages this run never touched', () => {
    const merged = mergePageObjectRecords(
      [record({ pageId: 'p9', className: 'CartPage' })],
      [record()],
    );
    expect(merged.map((r) => r.pageId)).toEqual(['p1', 'p9']);
  });

  it('is idempotent — regenerating the same feature changes nothing', () => {
    const once = mergePageObjectRecords([], [record()]);
    expect(mergePageObjectRecords(once, [record()])).toEqual(once);
  });

  it('does not depend on which feature was generated first', () => {
    const a = record();
    const b = record({
      features: ['search'],
      elementIds: ['el-search'],
      actions: [{ kind: 'fill', elementId: 'el-search' }],
    });
    expect(mergePageObjectRecords(mergePageObjectRecords([], [a]), [b])).toEqual(
      mergePageObjectRecords(mergePageObjectRecords([], [b]), [a]),
    );
  });

  it('takes the class name from the current run, so a renamed page renames', () => {
    const merged = mergePageObjectRecords([record()], [record({ className: 'SignInPage' })]);
    expect(merged[0]?.className).toBe('SignInPage');
  });

  it('deduplicates a repeated element or action', () => {
    const merged = mergePageObjectRecords(
      [],
      [
        record({
          elementIds: ['el-a', 'el-a'],
          actions: [
            { kind: 'click', elementId: 'el-a' },
            { kind: 'click', elementId: 'el-a' },
          ],
        }),
      ],
    );
    expect(merged[0]?.elementIds).toEqual(['el-a']);
    expect(merged[0]?.actions).toEqual([{ kind: 'click', elementId: 'el-a' }]);
  });
});

describe('pruneToModel', () => {
  /**
   * The record is a union across every feature and nothing ever removed from
   * it. So ids that died when `testIdAttribute` changed stayed forever, were
   * re-dropped on every `flint generate`, and logged the same warning every
   * time — which is how the one warning that matters gets ignored.
   */
  it('drops element ids the Screen Model no longer has', () => {
    const pruned = pruneToModel(
      [
        {
          className: 'HomePage',
          pageId: 'p1',
          features: ['login'],
          elementIds: ['el-live', 'el-dead'],
          actions: [
            { kind: 'click', elementId: 'el-live' },
            { kind: 'click', elementId: 'el-dead' },
          ],
        },
      ],
      new Set(['el-live']),
    );
    expect(pruned[0]?.elementIds).toEqual(['el-live']);
    expect(pruned[0]?.actions).toEqual([{ kind: 'click', elementId: 'el-live' }]);
  });

  it('drops a page object with nothing left — the page is gone', () => {
    const pruned = pruneToModel(
      [
        {
          className: 'GonePage',
          pageId: 'p9',
          features: ['login'],
          elementIds: ['el-dead'],
          actions: [],
        },
      ],
      new Set(['el-live']),
    );
    expect(pruned).toEqual([]);
  });

  it('leaves a fully live record untouched', () => {
    const record = {
      className: 'HomePage',
      pageId: 'p1',
      features: ['login'],
      elementIds: ['el-a', 'el-b'],
      actions: [{ kind: 'click' as const, elementId: 'el-a' }],
    };
    expect(pruneToModel([record], new Set(['el-a', 'el-b']))).toEqual([record]);
  });
});
