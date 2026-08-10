import { describe, it, expect } from 'vitest';
import { TestGenConfigSchema } from './config.js';

const minimalValid = {
  baseUrl: 'https://app.example.com',
  envClass: 'test',
  models: {
    planner: 'claude-sonnet-4-5',
    coder: 'claude-haiku-4-5',
    repair: 'claude-sonnet-4-5',
  },
};

describe('TestGenConfigSchema', () => {
  it('accepts a minimal valid config and applies defaults', () => {
    const parsed = TestGenConfigSchema.parse(minimalValid);
    expect(parsed.suiteDir).toBe('e2e');
    expect(parsed.dialect).toBe('playwright-pom');
    expect(parsed.explorer.maxPages).toBe(50);
    expect(parsed.explorer.dangerousActionPatterns).toContain('logout');
    expect(parsed.auth.mode).toBe('none');
    expect(parsed.tokenBudgets.plan).toBeGreaterThan(0);
    expect(parsed.debug.logPrompts).toBe(false);
  });

  it('rejects a non-URL baseUrl with a message naming the key', () => {
    const result = TestGenConfigSchema.safeParse({ ...minimalValid, baseUrl: 'not-a-url' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes('baseUrl'));
      expect(issue?.path).toEqual(['baseUrl']);
      expect(issue?.message).toMatch(/absolute URL/);
    }
  });

  it('rejects an invalid envClass with an enum message', () => {
    const result = TestGenConfigSchema.safeParse({ ...minimalValid, envClass: 'prod' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes('envClass'));
      expect(issue?.message).toMatch(/test|staging|production/);
    }
  });

  it('rejects storageState auth without a storageStatePath, naming the field', () => {
    const result = TestGenConfigSchema.safeParse({
      ...minimalValid,
      auth: { mode: 'storageState' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('storageStatePath'))).toBe(true);
    }
  });

  it('rejects a non-positive maxPages, naming the nested key', () => {
    const result = TestGenConfigSchema.safeParse({
      ...minimalValid,
      explorer: { maxPages: -5 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join('.') === 'explorer.maxPages');
      expect(issue?.message).toMatch(/positive integer/);
    }
  });

  it('rejects an unknown top-level key (strict schema)', () => {
    const result = TestGenConfigSchema.safeParse({ ...minimalValid, baseURL: 'https://x.com' });
    expect(result.success).toBe(false);
  });

  it('requires models to be present', () => {
    const { models: _omit, ...noModels } = minimalValid;
    const result = TestGenConfigSchema.safeParse(noModels);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('models'))).toBe(true);
    }
  });
});
