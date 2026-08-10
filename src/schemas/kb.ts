import { z } from 'zod';

/**
 * Knowledge-base feature-spec frontmatter schema — master plan B4 (LOCKED).
 *
 * Feature specs live in `kb/features/*.md` as YAML frontmatter + markdown body.
 * The frontmatter is the machine-readable part the Context Builder (Phase 3)
 * uses to select relevant Screen Model pages and cross-reference acceptance
 * criteria. The markdown body is free-form prose for the planner.
 *
 * Fields beyond the abridged B4 sketch (recorded in PHASE_NOTES.md): explicit
 * `acceptanceCriteria`, `negativeCases`, `dataNeeds`, and `status`, all of
 * which downstream phases reference.
 */

export const FeaturePrioritySchema = z.enum(['p0', 'p1', 'p2']);

export const FeatureSpecFrontmatterSchema = z
  .object({
    /** Stable feature id; used for tags (@feature:<id>) and coverage map. */
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'id must be kebab-case (a-z, 0-9, hyphen)'),
    title: z.string().min(1),
    priority: FeaturePrioritySchema.default('p1'),
    /** URL/urlPattern hints to match Screen Model pages. */
    pages: z.array(z.string()).optional(),
    /** Flow-script ids relevant to this feature. */
    flows: z.array(z.string()).optional(),
    tags: z.array(z.string()).default([]),
    /** Acceptance criteria the plan must cover (checklist cross-reference). */
    acceptanceCriteria: z.array(z.string()).optional(),
    /** Negative/edge cases explicitly required. */
    negativeCases: z.array(z.string()).optional(),
    /** Declared data prerequisites. */
    dataNeeds: z.array(z.string()).optional(),
    status: z.enum(['draft', 'ready', 'generated']).default('draft'),
  })
  .strict();
export type FeatureSpecFrontmatter = z.infer<typeof FeatureSpecFrontmatterSchema>;
