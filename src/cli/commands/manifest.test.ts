import { describe, it, expect } from 'vitest';
import { shrinkage } from './manifest.js';
import type { SuiteManifest } from '../../schemas/manifest.js';

/**
 * A scan that looks in fewer places does not fail. It writes a smaller manifest
 * and prints a cheerful summary, and the counts are the only evidence — which
 * nobody remembers from yesterday.
 *
 * On the real BAP suite `--root packages/utilities --root packages/data` was the
 * difference between 25 credential getters and zero, and zero is worse than an
 * error: with no credentials the prompt has no credential section at all, so the
 * model invented two getter names that looked exactly like real ones.
 */
const EMPTY: SuiteManifest = {
  version: 1,
  generatedAt: '2026-08-18T00:00:00.000Z',
  suiteDir: 'e2e',
  roots: [],
  flows: [],
  data: [],
  helpers: [],
  credentials: [],
  repositories: [],
  constants: [],
  warnings: [],
};

const credential = (getter: string) => ({ getter, file: 'packages/data/BAP.ts' });

describe('shrinkage', () => {
  it('names what a narrower scan lost, with both numbers', () => {
    const before = { ...EMPTY, credentials: [credential('getA'), credential('getB')] };
    expect(shrinkage(before, EMPTY)).toEqual(['credentials 2 -> 0']);
  });

  it('says nothing when the scan found the same or more', () => {
    const before = { ...EMPTY, credentials: [credential('getA')] };
    const after = { ...EMPTY, credentials: [credential('getA'), credential('getB')] };
    expect(shrinkage(before, after)).toEqual([]);
    expect(shrinkage(before, before)).toEqual([]);
  });

  it('says nothing on a first scan, where there is nothing to compare', () => {
    expect(shrinkage(undefined, EMPTY)).toEqual([]);
  });

  it('reports every category that shrank, not just the first', () => {
    const before = {
      ...EMPTY,
      credentials: [credential('getA')],
      repositories: [{ className: 'UserRepository', file: 'r.ts', methods: ['updateGAQ'] }],
    };
    expect(shrinkage(before, EMPTY)).toEqual(['credentials 1 -> 0', 'repositories 1 -> 0']);
  });
});
