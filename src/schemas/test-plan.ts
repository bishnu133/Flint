import { z } from 'zod';

/**
 * TestPlan schema — master plan B4 (LOCKED once written).
 *
 * A human-reviewable JSON plan produced before any TypeScript is written.
 * Every `elementRef` MUST be an Element.id from the ScreenModel — the planner's
 * referential validator (Phase 3) enforces this so the LLM can never invent an
 * element.
 *
 * Fields beyond the abridged B4 sketch (recorded in PHASE_NOTES.md), added now
 * because the schema locks after Phase 0 and Phase 3 explicitly requires them:
 *   - TestCase.status 'blocked' + blockedReason (spec references missing UI)
 *   - TestCase.prerequisites (structured setup a case needs before it can pass)
 *   - TestCase.acceptanceRefs (cross-reference to spec acceptance criteria)
 *   - Assertion.kind enum (visible/hidden/text/url/count/value/toast)
 *   - TestPlan.openQuestions (planner asks instead of guessing on p0)
 */

export const PlanActionSchema = z.enum(['goto', 'click', 'fill', 'select', 'assert', 'custom']);
export type PlanAction = z.infer<typeof PlanActionSchema>;

export const AssertionKindSchema = z.enum([
  'visible',
  'hidden',
  'text',
  'url',
  'count',
  'value',
  'toast',
]);
export type AssertionKind = z.infer<typeof AssertionKindSchema>;

export const AssertionSchema = z
  .object({
    kind: AssertionKindSchema,
    expected: z.union([z.string(), z.number(), z.boolean()]),
  })
  .strict();
export type Assertion = z.infer<typeof AssertionSchema>;

export const PlanStepSchema = z
  .object({
    action: PlanActionSchema,
    /** MUST be an Element.id from the ScreenModel (validated in Phase 3). */
    elementRef: z.string().optional(),
    value: z.string().optional(),
    assertion: AssertionSchema.optional(),
    note: z.string().optional(),
  })
  .strict()
  .superRefine((step, ctx) => {
    if (step.action === 'assert' && step.assertion === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "assert step requires an 'assertion'",
        path: ['assertion'],
      });
    }
    if ((step.action === 'fill' || step.action === 'select') && step.value === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${step.action} step requires a 'value'`,
        path: ['value'],
      });
    }
  });
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const CasePrioritySchema = z.enum(['p0', 'p1', 'p2']);
export type CasePriority = z.infer<typeof CasePrioritySchema>;

/**
 * What the Emitter (Phase 4) should DO with this case. The Planner (Phase 3)
 * decides the status by cross-referencing the Suite Index coverage map and the
 * Screen Model; the Emitter never re-decides it.
 *
 * | status              | Planner sets it when…                                        | Emitter does…                                    |
 * | ------------------- | ------------------------------------------------------------ | ------------------------------------------------ |
 * | `new`               | No existing test covers this behaviour.                        | Writes a brand-new test.                          |
 * | `skipped-duplicate` | Suite Index already covers it. Requires `duplicateOf`.         | Writes nothing; the case is a reviewable record.  |
 * | `update-existing`   | A test exists but the spec changed. Requires `duplicateOf`.    | Edits in place if managed; sibling file if hand-edited. |
 * | `blocked`           | The spec needs UI absent from the Screen Model. Requires `blockedReason`. | Emits `test.fixme()` carrying the reason. |
 *
 * `blocked` exists to enforce core principle #1 (ground before you generate):
 * when a spec references an element exploration never saw, the planner must
 * surface that gap rather than invent a selector.
 *
 * Status is deliberately NOT the place to record "this needs test data or
 * config first" — that is an independent axis; see {@link PrerequisiteSchema}.
 */
export const CaseStatusSchema = z.enum(['new', 'skipped-duplicate', 'update-existing', 'blocked']);
export type CaseStatus = z.infer<typeof CaseStatusSchema>;

/** What kind of setup a prerequisite describes. */
export const PrerequisiteKindSchema = z.enum([
  /** Seeded records the test reads or acts on. */
  'data',
  /** A config value or environment variable the suite needs. */
  'config',
  /** A third-party sandbox or dependency that must be reachable. */
  'external-service',
  /** Anything a human must do by hand before the test can pass. */
  'manual',
]);
export type PrerequisiteKind = z.infer<typeof PrerequisiteKindSchema>;

/**
 * Something that must exist before a case can PASS — as opposed to
 * {@link CaseStatusSchema}, which says what the Emitter should WRITE.
 *
 * The two axes are independent on purpose: a case can be `new` and need data,
 * or `update-existing` and need data. Collapsing them into one enum would
 * force the Emitter to choose between knowing where to write and knowing
 * whether the test is runnable.
 *
 * Emitter rule (Phase 4), in order:
 *   1. `blocked`                → `test.fixme()` carrying `blockedReason`
 *   2. `prerequisites` non-empty → the COMPLETE test, emitted as `test.skip()`
 *                                  with a `@needs-setup` tag and each
 *                                  prerequisite as a comment
 *   3. otherwise                 → a live test
 *
 * Step 2 matters for Phase 5: a skipped test never runs, so the repair loop
 * cannot waste iterations "fixing" correct code, and a missing fixture can
 * never be misreported as a possible application defect.
 */
export const PrerequisiteSchema = z
  .object({
    kind: PrerequisiteKindSchema,
    /** Human-readable, specific: "a user with at least 3 completed orders". */
    description: z.string().min(1, 'prerequisite description must not be empty'),
    /** Config key or env var name, when `kind` is 'config'. */
    key: z.string().optional(),
  })
  .strict();
export type Prerequisite = z.infer<typeof PrerequisiteSchema>;

export const TestCaseSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    priority: CasePrioritySchema,
    tags: z.array(z.string()),
    status: CaseStatusSchema,
    /**
     * Suite-index test id this case targets. Required for both
     * `skipped-duplicate` (what it duplicates) and `update-existing` (what it
     * updates) — the Emitter cannot act on either without a target.
     */
    duplicateOf: z.string().optional(),
    /** Reason a case is blocked (e.g. element not found in exploration). */
    blockedReason: z.string().optional(),
    /**
     * What must exist before this case can pass. Non-empty ⇒ the Emitter still
     * writes the full test, but marks it skipped. See {@link PrerequisiteSchema}.
     */
    prerequisites: z.array(PrerequisiteSchema).optional(),
    /** Acceptance-criterion ids from the feature spec this case covers. */
    acceptanceRefs: z.array(z.string()).optional(),
    steps: z.array(PlanStepSchema),
  })
  .strict()
  .superRefine((testCase, ctx) => {
    if (testCase.status === 'skipped-duplicate' && testCase.duplicateOf === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "skipped-duplicate case requires 'duplicateOf'",
        path: ['duplicateOf'],
      });
    }
    if (testCase.status === 'update-existing' && testCase.duplicateOf === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "update-existing case requires 'duplicateOf' naming the test it updates",
        path: ['duplicateOf'],
      });
    }
    if (testCase.status === 'blocked' && testCase.blockedReason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "blocked case requires 'blockedReason'",
        path: ['blockedReason'],
      });
    }
  });
export type TestCase = z.infer<typeof TestCaseSchema>;

export const TestPlanSchema = z
  .object({
    featureId: z.string().min(1),
    generatedAt: z.string().datetime(),
    screenModelVersion: z.string().min(1),
    cases: z.array(TestCaseSchema),
    /** Planner questions for humans instead of guessing on ambiguous specs. */
    openQuestions: z.array(z.string()).optional(),
  })
  .strict();
export type TestPlan = z.infer<typeof TestPlanSchema>;
