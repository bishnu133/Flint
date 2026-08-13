import { describe, it, expect } from 'vitest';
import { FlintConfigSchema } from './config.js';

const minimalValid = {
  baseUrl: 'https://app.example.com',
  envClass: 'test',
  models: {
    planner: 'claude-opus-5',
    coder: 'claude-sonnet-5',
    repair: 'claude-opus-5',
  },
};

describe('FlintConfigSchema', () => {
  it('accepts a minimal valid config and applies defaults', () => {
    const parsed = FlintConfigSchema.parse(minimalValid);
    expect(parsed.suiteDir).toBe('e2e');
    expect(parsed.dialect).toBe('playwright-pom');
    expect(parsed.explorer.maxPages).toBe(50);
    expect(parsed.explorer.dangerousActionPatterns).toContain('logout');
    expect(parsed.auth.mode).toBe('none');
    expect(parsed.tokenBudgets.plan).toBeGreaterThan(0);
    expect(parsed.debug.logPrompts).toBe(false);
  });

  it('rejects a non-URL baseUrl with a message naming the key', () => {
    const result = FlintConfigSchema.safeParse({ ...minimalValid, baseUrl: 'not-a-url' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes('baseUrl'));
      expect(issue?.path).toEqual(['baseUrl']);
      expect(issue?.message).toMatch(/absolute URL/);
    }
  });

  it('rejects an invalid envClass with an enum message', () => {
    const result = FlintConfigSchema.safeParse({ ...minimalValid, envClass: 'prod' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes('envClass'));
      expect(issue?.message).toMatch(/test|staging|production/);
    }
  });

  it('rejects storageState auth without a storageStatePath, naming the field', () => {
    const result = FlintConfigSchema.safeParse({
      ...minimalValid,
      auth: { mode: 'storageState' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('storageStatePath'))).toBe(true);
    }
  });

  it('rejects a non-positive maxPages, naming the nested key', () => {
    const result = FlintConfigSchema.safeParse({
      ...minimalValid,
      explorer: { maxPages: -5 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join('.') === 'explorer.maxPages');
      expect(issue?.message).toMatch(/positive integer/);
    }
  });

  it('defaults testIdAttribute to data-testid, so existing configs keep working', () => {
    // The key was added after Phase 0 with explicit approval. Additive and
    // defaulted to the value that was previously hardcoded, so no project that
    // predates it changes behaviour on upgrade.
    expect(FlintConfigSchema.parse(minimalValid).explorer.testIdAttribute).toBe('data-testid');
  });

  it('accepts an app-specific testIdAttribute', () => {
    const parsed = FlintConfigSchema.parse({
      ...minimalValid,
      explorer: { testIdAttribute: 'data-test' },
    });
    expect(parsed.explorer.testIdAttribute).toBe('data-test');
  });

  it('rejects an empty testIdAttribute, naming a value that would work', () => {
    // An empty string would build `[="x"]` — a selector that throws at runtime
    // rather than one that merely fails to match, so it must not parse.
    const result = FlintConfigSchema.safeParse({
      ...minimalValid,
      explorer: { testIdAttribute: '' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(
        (i) => i.path.join('.') === 'explorer.testIdAttribute',
      );
      expect(issue?.message).toMatch(/data-testid/);
    }
  });

  it('rejects an unknown top-level key (strict schema)', () => {
    const result = FlintConfigSchema.safeParse({ ...minimalValid, baseURL: 'https://x.com' });
    expect(result.success).toBe(false);
  });

  it('requires models to be present', () => {
    const { models: _omit, ...noModels } = minimalValid;
    const result = FlintConfigSchema.safeParse(noModels);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('models'))).toBe(true);
    }
  });
});
