import { describe, it, expect } from 'vitest';
import { SuiteIndexSchema } from './suite-index.js';

const emptyIndex = {
  generatedAt: '2026-08-10T00:00:00.000Z',
  suiteDir: 'e2e',
  pageObjects: [],
  specs: [],
  fixtures: [],
  dataFactories: [],
  coverageMap: {},
  managedFiles: [],
  handEditedFiles: [],
};

describe('SuiteIndexSchema', () => {
  it('accepts a valid empty index (no-suite / empty-suite case)', () => {
    const parsed = SuiteIndexSchema.parse(emptyIndex);
    expect(parsed.pageObjects).toHaveLength(0);
  });

  it('accepts a populated index with coverage map', () => {
    const parsed = SuiteIndexSchema.parse({
      ...emptyIndex,
      pageObjects: [
        {
          className: 'LoginPage',
          file: 'e2e/pages/login.page.ts',
          methods: [{ name: 'login', selectorsUsed: ['[data-testid=user]'] }],
          selectorsUsed: ['[data-testid=user]'],
        },
      ],
      coverageMap: { login: ['tc-1'] },
    });
    expect(parsed.coverageMap.login).toEqual(['tc-1']);
  });

  it('rejects a missing required field, naming it', () => {
    const { managedFiles: _omit, ...missing } = emptyIndex;
    const result = SuiteIndexSchema.safeParse(missing);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('managedFiles'))).toBe(true);
    }
  });

  it('rejects a coverageMap whose value is not an array of strings', () => {
    const result = SuiteIndexSchema.safeParse({ ...emptyIndex, coverageMap: { login: 'tc-1' } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['coverageMap', 'login']);
    }
  });
});
