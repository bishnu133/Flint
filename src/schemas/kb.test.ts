import { describe, it, expect } from 'vitest';
import { FeatureSpecFrontmatterSchema } from './kb.js';

describe('FeatureSpecFrontmatterSchema', () => {
  it('accepts valid frontmatter and applies defaults', () => {
    const parsed = FeatureSpecFrontmatterSchema.parse({ id: 'checkout', title: 'Checkout flow' });
    expect(parsed.priority).toBe('p1');
    expect(parsed.tags).toEqual([]);
    expect(parsed.status).toBe('draft');
  });

  it('rejects a non-kebab-case id with a helpful message', () => {
    const result = FeatureSpecFrontmatterSchema.safeParse({ id: 'Check Out', title: 'x' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes('id'));
      expect(issue?.message).toMatch(/kebab-case/);
    }
  });

  it('rejects missing title, naming the field', () => {
    const result = FeatureSpecFrontmatterSchema.safeParse({ id: 'checkout' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('title'))).toBe(true);
    }
  });

  it('rejects an unknown extra key (strict schema)', () => {
    const result = FeatureSpecFrontmatterSchema.safeParse({
      id: 'checkout',
      title: 'Checkout',
      priorty: 'p0', // typo
    });
    expect(result.success).toBe(false);
  });
});
