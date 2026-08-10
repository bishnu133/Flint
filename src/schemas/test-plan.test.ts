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

  it('rejects an update-existing case without a target reference', () => {
    const result = TestCaseSchema.safeParse({ ...validCase, status: 'update-existing' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes('duplicateOf'));
      expect(issue?.message).toMatch(/update-existing case requires 'duplicateOf'/);
    }
  });

  it('accepts update-existing when duplicateOf names the target', () => {
    const parsed = TestCaseSchema.parse({
      ...validCase,
      status: 'update-existing',
      duplicateOf: 'login.spec.ts::user can log in',
    });
    expect(parsed.duplicateOf).toBe('login.spec.ts::user can log in');
  });
});

describe('TestCase.prerequisites', () => {
  it('is independent of status — a new case can also need setup', () => {
    const parsed = TestCaseSchema.parse({
      ...validCase,
      status: 'new',
      prerequisites: [
        { kind: 'data', description: 'A user with at least 3 completed orders' },
        { kind: 'config', description: 'Stripe sandbox key', key: 'STRIPE_TEST_KEY' },
      ],
    });
    expect(parsed.status).toBe('new');
    expect(parsed.prerequisites).toHaveLength(2);
    expect(parsed.prerequisites?.[1]?.key).toBe('STRIPE_TEST_KEY');
  });

  it('is independent of status — an update can also need setup', () => {
    const parsed = TestCaseSchema.parse({
      ...validCase,
      status: 'update-existing',
      duplicateOf: 'orders.spec.ts::history',
      prerequisites: [{ kind: 'external-service', description: 'Payments sandbox reachable' }],
    });
    expect(parsed.status).toBe('update-existing');
    expect(parsed.prerequisites?.[0]?.kind).toBe('external-service');
  });

  it('rejects an unknown prerequisite kind with an enum message', () => {
    const result = TestCaseSchema.safeParse({
      ...validCase,
      prerequisites: [{ kind: 'database', description: 'seed it' }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes('kind'));
      expect(issue?.message).toMatch(/data/);
    }
  });

  it('rejects an empty prerequisite description', () => {
    const result = TestCaseSchema.safeParse({
      ...validCase,
      prerequisites: [{ kind: 'manual', description: '' }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/must not be empty/);
    }
  });

  it('rejects an unknown key inside a prerequisite (strict)', () => {
    const result = TestCaseSchema.safeParse({
      ...validCase,
      prerequisites: [{ kind: 'data', description: 'a user', seedScript: 'seed.sql' }],
    });
    expect(result.success).toBe(false);
  });
});
