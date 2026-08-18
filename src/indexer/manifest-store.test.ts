import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SuiteManifest } from '../schemas/manifest.js';
import {
  formatManifestSummary,
  hasMissingRoots,
  manifestPath,
  readManifest,
  tryReadManifest,
  writeManifest,
} from './manifest-store.js';

let root: string;

/** The actionable half of a Flint error lives on `hint`, not in the message. */
function hintOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as { hint?: string }).hint ?? '';
  }
  throw new Error('expected the call to throw');
}

const MANIFEST: SuiteManifest = {
  version: 1,
  generatedAt: '2026-08-17T00:00:00.000Z',
  suiteDir: 'e2e',
  roots: [],
  flows: [
    {
      id: 'login.loginFlow',
      file: 'flows/login.flow.ts',
      exportName: 'loginFlow',
      domain: 'login',
      kind: 'auth',
      summary: 'Logs in.',
      params: [],
      returns: 'Promise<void>',
      phrases: ['Click the Login button'],
      usedBy: ['tests/cart.test.mts'],
    },
    {
      id: 'login.logoutFlow',
      file: 'flows/login.flow.ts',
      exportName: 'logoutFlow',
      domain: 'login',
      kind: 'auth',
      params: [],
      returns: 'Promise<void>',
      phrases: [],
      usedBy: [],
    },
  ],
  data: [],
  helpers: [],
  credentials: [],
  repositories: [],
  warnings: [],
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'flint-manifest-store-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('writeManifest / readManifest', () => {
  it('round-trips', () => {
    writeManifest(root, MANIFEST);
    expect(readManifest(root)).toEqual(MANIFEST);
  });

  it('reads a manifest written before `roots` existed', () => {
    // Every project with a manifest already on disk has one of these. It must
    // read as "no extra roots recorded" rather than failing, so the first
    // command after an upgrade still works and simply asks for --root again.
    const { roots: _roots, ...older } = MANIFEST;
    mkdirSync(dirname(manifestPath(root)), { recursive: true });
    writeFileSync(manifestPath(root), JSON.stringify(older), 'utf8');
    expect(readManifest(root).roots).toEqual([]);
  });

  it('names the command to run when there is no manifest', () => {
    expect(() => readManifest(root)).toThrow(/No suite manifest/);
    expect(hintOf(() => readManifest(root))).toMatch(/flint manifest/);
  });

  it('says the file is safe to delete when it is corrupt', () => {
    // It is derived data, so the fix really is "delete and rescan" — the error
    // should say so rather than leaving someone wondering what they lost.
    const path = manifestPath(root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'not json', 'utf8');
    expect(hintOf(() => readManifest(root))).toMatch(/nothing is lost/);
  });
});

describe('tryReadManifest', () => {
  it('is undefined rather than throwing when absent', () => {
    expect(tryReadManifest(root)).toBeUndefined();
  });

  it('is undefined rather than throwing when corrupt', () => {
    const path = manifestPath(root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{]', 'utf8');
    expect(tryReadManifest(root)).toBeUndefined();
  });
});

describe('formatManifestSummary', () => {
  it('counts each layer', () => {
    const out = formatManifestSummary(MANIFEST);
    expect(out).toContain('Flows           2');
    expect(out).toContain('auth        2');
  });

  it('names flows no test imports', () => {
    // The most useful thing in the summary: a flow nothing imports is either
    // dead or about to be duplicated by someone who could not find it.
    expect(formatManifestSummary(MANIFEST)).toContain('login.logoutFlow');
  });

  it('says nothing about unused flows when every one is used', () => {
    const allUsed = {
      ...MANIFEST,
      flows: MANIFEST.flows.map((f) => ({ ...f, usedBy: ['tests/x.test.mts'] })),
    };
    expect(formatManifestSummary(allUsed)).not.toContain('not imported');
  });
});

describe('formatManifestSummary — missing paths', () => {
  const missing: SuiteManifest = {
    ...MANIFEST,
    flows: [],
    warnings: [
      {
        file: '/abs/packages/WRONG',
        message: 'suiteDir does not exist — nothing was scanned from here.',
      },
    ],
  };

  it('puts the path problem above the counts', () => {
    // Someone who reads "Flows 0" before the reason concludes the scanner is
    // broken, and reports that instead of fixing their path.
    const out = formatManifestSummary(missing);
    expect(out.indexOf('/abs/packages/WRONG')).toBeLessThan(out.indexOf('Flows'));
  });

  it('does not also list it as a parse failure', () => {
    // Nothing was parsed because nothing was there — a different fault.
    expect(formatManifestSummary(missing)).not.toContain('could not be parsed');
  });

  it('still reports genuine parse failures', () => {
    const both: SuiteManifest = {
      ...missing,
      warnings: [
        ...missing.warnings,
        { file: 'flows/broken.flow.ts', message: 'Unexpected token' },
      ],
    };
    const out = formatManifestSummary(both);
    expect(out).toContain('1 file(s) could not be parsed');
    expect(out).toContain('flows/broken.flow.ts');
  });
});

describe('hasMissingRoots', () => {
  it('is false for a clean scan of a genuinely empty suite', () => {
    expect(hasMissingRoots({ ...MANIFEST, flows: [], warnings: [] })).toBe(false);
  });

  it('is true when a root was missing', () => {
    expect(
      hasMissingRoots({
        ...MANIFEST,
        warnings: [{ file: '/x', message: '--root does not exist — nothing was scanned' }],
      }),
    ).toBe(true);
  });
});
