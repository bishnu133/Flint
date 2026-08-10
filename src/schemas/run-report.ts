import { z } from 'zod';

/**
 * RunReport schema — master plan B4 (LOCKED once written).
 *
 * The output of the Verifier (Phase 5): per-test status, deterministic failure
 * classification, and repair history. `assertion-mismatch` failures that
 * survive repair are surfaced as possible application defects (never weakened).
 */

export const FailureClassSchema = z.enum([
  'selector-not-found',
  'timeout',
  'assertion-mismatch',
  'navigation',
  'env',
  'unknown',
]);
export type FailureClass = z.infer<typeof FailureClassSchema>;

export const TestStatusSchema = z.enum(['passed', 'failed', 'skipped', 'flaky', 'fixme']);
export type TestStatus = z.infer<typeof TestStatusSchema>;

export const TestResultSchema = z
  .object({
    title: z.string().min(1),
    file: z.string().min(1),
    status: TestStatusSchema,
    failureClass: FailureClassSchema.optional(),
    errorExcerpt: z.string().optional(),
    repairAttempts: z.number().int().min(0),
    /** Trace/screenshot artifact paths attached by the classifier. */
    artifacts: z.array(z.string()).optional(),
    /** Surfaced when an assertion-mismatch survives repair (possible app bug). */
    possibleAppDefect: z.boolean().optional(),
    durationMs: z.number().min(0).optional(),
  })
  .strict()
  .superRefine((result, ctx) => {
    if (result.status === 'failed' && result.failureClass === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "failed test requires a 'failureClass'",
        path: ['failureClass'],
      });
    }
  });
export type TestResult = z.infer<typeof TestResultSchema>;

export const RunSummarySchema = z
  .object({
    total: z.number().int().min(0),
    passed: z.number().int().min(0),
    failed: z.number().int().min(0),
    skipped: z.number().int().min(0),
    flaky: z.number().int().min(0),
    fixme: z.number().int().min(0),
  })
  .strict();
export type RunSummary = z.infer<typeof RunSummarySchema>;

export const RunReportSchema = z
  .object({
    runId: z.string().min(1),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime(),
    baseUrl: z.string().url(),
    /** True when a pre-run health check failed — results are env, not test, failures. */
    envHealthy: z.boolean(),
    summary: RunSummarySchema,
    tests: z.array(TestResultSchema),
  })
  .strict();
export type RunReport = z.infer<typeof RunReportSchema>;
