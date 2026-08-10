import { describe, it, expect } from 'vitest';
import { TestPlanSchema, TestCaseSchema, PlanStepSchema } from './test-plan.js';

const validCase = {
  id: 'tc-1',
  title: 'User can log in',
  priority: 'p0',
  tags: ['@feature:login'],
  status: 'new',
  steps: [
    { action: 'goto', value: '/login' },
    { action: 'fill', elementRef: 'el-user', value: 'standard_user' },
    { action: 'assert', assertion: { kind: 'url', expected: '/dashboard' } },
  ],
};

const validPlan = {
  featureId: 'login',
  generatedAt: '2026-08-10T00:00:00.000Z',
  screenModelVersion: '1',
  cases: [validCase],
};

describe('TestPlanSchema', () => {
  it('accepts a well-formed plan', () => {
    const parsed = TestPlanSchema.parse(validPlan);
    expect(parsed.cases[0]?.steps).toHaveLength(3);
  });

  it('rejects an assert step with no assertion, naming the field', () => {
    const result = PlanStepSchema.safeParse({ action: 'assert' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues[0];
      expect(issue?.path).toEqual(['assertion']);
      expect(issue?.message).toMatch(/assert step requires an 'assertion'/);
    }
  });

  it('rejects a fill step with no value, naming the field', () => {
    const result = PlanStepSchema.safeParse({ action: 'fill', elementRef: 'el-user' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/fill step requires a 'value'/);
    }
  });

  it('rejects a skipped-duplicate case without duplicateOf', () => {
    const result = TestCaseSchema.safeParse({ ...validCase, status: 'skipped-duplicate' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes('duplicateOf'));
      expect(issue?.message).toMatch(/skipped-duplicate case requires 'duplicateOf'/);
    }
  });

  it('rejects a blocked case without blockedReason', () => {
    const result = TestCaseSchema.safeParse({ ...validCase, status: 'blocked' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('blockedReason'))).toBe(true);
    }
  });
});
