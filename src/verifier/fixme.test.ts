import { describe, it, expect } from 'vitest';
import { applyFixme, FIXME_MARKER } from './fixme.js';

/**
 * Idempotence gets the most attention here, because the compounding failure is
 * silent: run twice and the block stacks, `test.fixme` becomes
 * `test.fixme.fixme`, and the file stops parsing several verifies later with no
 * obvious cause. That shape of bug appeared four times in Phase 4.
 */

const SPEC = `import { test, expect } from '@playwright/test';

test('signs in with valid credentials', async ({ page }) => {
  await page.goto('/');
});

test('rejects a bad password', async ({ page }) => {
  await page.goto('/');
});
`;

const COMMENT = [
  'Flint could not repair this test (selector-not-found).',
  '',
  'Last error:',
  '  boom',
];

describe('applyFixme', () => {
  it('converts the named test to test.fixme and adds the comment above it', () => {
    const result = applyFixme(SPEC, 'signs in with valid credentials', COMMENT);
    expect(result.changed).toBe(true);
    expect(result.source).toContain(`test.fixme('signs in with valid credentials'`);
    expect(result.source).toContain(FIXME_MARKER);
    expect(result.source).toContain('Flint could not repair this test');
  });

  it('leaves every other test alone', () => {
    const result = applyFixme(SPEC, 'signs in with valid credentials', COMMENT);
    expect(result.source).toContain(`test('rejects a bad password'`);
    expect(result.source.match(/test\.fixme/g)).toHaveLength(1);
  });

  it('is idempotent — a second pass changes nothing', () => {
    // The whole reason this function is not a regex replace.
    const once = applyFixme(SPEC, 'signs in with valid credentials', COMMENT);
    const twice = applyFixme(once.source, 'signs in with valid credentials', COMMENT);
    expect(twice.changed).toBe(false);
    expect(twice.source).toBe(once.source);
    expect(twice.reason).toMatch(/already marked/);
  });

  it('still marks a second failing test in a file that already has one marked', () => {
    // The naive idempotence check — "does this file contain the marker?" —
    // would refuse here and leave the second failure undocumented.
    const once = applyFixme(SPEC, 'signs in with valid credentials', COMMENT);
    const twice = applyFixme(once.source, 'rejects a bad password', COMMENT);
    expect(twice.changed).toBe(true);
    expect(twice.source.match(/test\.fixme/g)).toHaveLength(2);
  });

  it('refuses rather than guessing when the title is not in the file', () => {
    const result = applyFixme(SPEC, 'a test nobody wrote', COMMENT);
    expect(result.changed).toBe(false);
    expect(result.source).toBe(SPEC);
    expect(result.reason).toMatch(/no test titled/);
  });

  it('does not match a title that merely starts the same way', () => {
    // `test('signs in')` must not be hit when repairing `test('signs in with
    // valid credentials')`, or repair disables the wrong test.
    const source = `test('signs in', async () => {});\n`;
    expect(applyFixme(source, 'signs in with valid credentials', COMMENT).changed).toBe(false);
  });

  it('preserves indentation so a nested test still reads correctly', () => {
    const nested = `test.describe('login', () => {\n  test('works', async () => {});\n});\n`;
    const result = applyFixme(nested, 'works', COMMENT);
    expect(result.changed).toBe(true);
    expect(result.source).toContain(`  test.fixme('works'`);
    expect(result.source).toContain('  /**');
  });

  it('handles double-quoted titles', () => {
    const source = `test("works", async () => {});\n`;
    const result = applyFixme(source, 'works', COMMENT);
    expect(result.changed).toBe(true);
    expect(result.source).toContain('test.fixme("works"');
  });

  it('does not mistake describe for test', () => {
    const source = `test.describe('works', () => {\n  test('inner', async () => {});\n});\n`;
    const result = applyFixme(source, 'works', COMMENT);
    expect(result.changed).toBe(false);
  });
});
