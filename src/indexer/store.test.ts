import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatIndex, indexPath, readIndex, tryReadIndex, writeIndex } from './store.js';
import { scanSuite } from './scan.js';
import { withMarker } from './managed.js';
import { ConfigError } from '../shared/errors.js';
import type { SuiteIndex } from '../schemas/suite-index.js';

let root: string;

const EMPTY: SuiteIndex = {
  generatedAt: new Date().toISOString(),
  suiteDir: 'e2e',
  pageObjects: [],
  specs: [],
  fixtures: [],
  dataFactories: [],
  coverageMap: {},
  managedFiles: [],
  handEditedFiles: [],
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'flint-index-store-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('writeIndex / readIndex', () => {
  it('round-trips an index', () => {
    const path = indexPath(root);
    writeIndex(path, EMPTY);
    expect(readIndex(path)).toEqual(EMPTY);
  });

  it('creates parent directories', () => {
    const path = join(root, 'nested', 'deep', 'suite-index.json');
    writeIndex(path, EMPTY);
    expect(readIndex(path).suiteDir).toBe('e2e');
  });

  it('errors actionably when the file is missing', () => {
    expect(() => readIndex(indexPath(root))).toThrowError(ConfigError);
    expect(() => readIndex(indexPath(root))).toThrow(/No Suite Index at/);
    // The actionable part lives in `hint`, which the CLI prints separately.
    try {
      readIndex(indexPath(root));
      expect.unreachable('readIndex should have thrown');
    } catch (err) {
      expect((err as ConfigError).hint).toMatch(/Run `flint index` first/);
    }
  });

  it('errors actionably on malformed JSON', () => {
    const path = indexPath(root);
    mkdirSync(join(root, '.flint'), { recursive: true });
    writeFileSync(path, '{ not json', 'utf8');
    expect(() => readIndex(path)).toThrow(/not valid JSON/);
  });

  it('errors actionably when the shape is wrong, naming the key', () => {
    const path = indexPath(root);
    mkdirSync(join(root, '.flint'), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...EMPTY, pageObjects: 'nope' }), 'utf8');
    expect(() => readIndex(path)).toThrow(/pageObjects/);
  });

  it('tryReadIndex returns undefined rather than throwing on a first run', () => {
    expect(tryReadIndex(indexPath(root))).toBeUndefined();
  });
});

describe('formatIndex', () => {
  it('summarises counts', () => {
    mkdirSync(join(root, 'e2e/pages'), { recursive: true });
    writeFileSync(join(root, 'e2e/pages/a.page.ts'), 'export class APage {}', 'utf8');
    writeFileSync(
      join(root, 'e2e/a.spec.ts'),
      `test('one @feature:f1', () => {}); test('two', () => {});`,
      'utf8',
    );
    const text = formatIndex(scanSuite({ projectRoot: root, suiteDir: 'e2e' }));
    expect(text).toMatch(/Page objects:\s+1/);
    expect(text).toMatch(/Spec files:\s+1 \(2 tests\)/);
    expect(text).toMatch(/Features covered:\s+1/);
  });

  it('calls out hand-edited files, since Flint will refuse to overwrite them', () => {
    mkdirSync(join(root, 'e2e'), { recursive: true });
    writeFileSync(
      join(root, 'e2e/edited.page.ts'),
      `${withMarker('export class E {}\n')}// human edit\n`,
      'utf8',
    );
    const text = formatIndex(scanSuite({ projectRoot: root, suiteDir: 'e2e' }));
    expect(text).toMatch(/Hand-edited generated files/);
    expect(text).toContain('e2e/edited.page.ts');
  });

  it('uses the singular for a single test', () => {
    mkdirSync(join(root, 'e2e'), { recursive: true });
    writeFileSync(join(root, 'e2e/a.spec.ts'), `test('only one', () => {});`, 'utf8');
    expect(formatIndex(scanSuite({ projectRoot: root, suiteDir: 'e2e' }))).toMatch(/\(1 test\)/);
  });
});
