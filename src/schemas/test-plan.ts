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
 *   - TestCase.dataNeeds (data prerequisites surfaced to humans)
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
 * | `update-existing`   | A test exists but the spec changed. Should name its target in `duplicateOf` — **not currently enforced, see PHASE_NOTES open question 5**. | Edits in place if managed; sibling file if hand-edited. |
 * | `blocked`           | The spec needs UI absent from the Screen Model. Requires `blockedReason`. | Emits `test.fixme()` carrying the reason. |
 *
 * `blocked` exists to enforce core principle #1 (ground before you generate):
 * when a spec references an element exploration never saw, the planner must
 * surface that gap rather than invent a selector.
 */
export const CaseStatusSchema = z.enum(['new', 'skipped-duplicate', 'update-existing', 'blocked']);
export type CaseStatus = z.infer<typeof CaseStatusSchema>;

export const TestCaseSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    priority: CasePrioritySchema,
    tags: z.array(z.string()),
    status: CaseStatusSchema,
    /** Suite-index test id this case duplicates, when status is skipped-duplicate. */
    duplicateOf: z.string().optional(),
    /** Reason a case is blocked (e.g. element not found in exploration). */
    blockedReason: z.string().optional(),
    /** Data prerequisites so humans see required test data. */
    dataNeeds: z.array(z.string()).optional(),
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
