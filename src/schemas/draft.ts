import { z } from 'zod';
import { FeaturePrioritySchema } from './kb.js';

/**
 * What a model may propose when reading a requirement document (Bubblegum B2.5).
 *
 * The shape is deliberately *not* the knowledge-base shape. A drafted state
 * carries a `setupHint` — free text like "set the user's GAQ status in the
 * database" — where the real KB carries `repository: UserRepository.updateGAQ`.
 * The model is asked what needs to happen; Flint decides what to call it, by
 * matching against the manifest.
 *
 * That split is the whole design. A model asked to name a method will name a
 * plausible one, and `UserRepository.setGAQStatus` looks exactly as convincing
 * as the method that exists. Keeping the resolution deterministic means a
 * drafted reference either points at real code or is visibly marked as
 * unresolved — never quietly wrong.
 */

export const DraftStateSchema = z
  .object({
    /** State name, kebab-case: `unfit`, `partial-fit`, `live`. */
    name: z.string().min(1),
    /**
     * How a test would reach this state, in plain words.
     *
     * Flint matches this against the manifest. Naming a real method is fine and
     * helps the match; inventing one costs nothing, because an unmatched hint
     * is written out as a TODO rather than as a working reference.
     */
    setupHint: z.string().min(1).optional(),
    /** Why no test can reach this state, when the document says so. */
    unreachableReason: z.string().min(1).optional(),
    note: z.string().min(1).optional(),
  })
  .strict();
export type DraftState = z.infer<typeof DraftStateSchema>;

export const DraftEntitySchema = z
  .object({
    entity: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'entity must be kebab-case'),
    /** Every other name the document uses for this thing. */
    aliases: z.array(z.string()).default([]),
    description: z.string().min(1).optional(),
    states: z.array(DraftStateSchema).default([]),
  })
  .strict();
export type DraftEntity = z.infer<typeof DraftEntitySchema>;

export const DraftRoleSchema = z
  .object({
    id: z.string().min(1),
    description: z.string().min(1).optional(),
    aliases: z.array(z.string()).default([]),
    /** How the document names the role; matched against credential getters. */
    credentialsHint: z.string().min(1).optional(),
  })
  .strict();
export type DraftRole = z.infer<typeof DraftRoleSchema>;

export const DraftFeatureSchema = z
  .object({
    /**
     * Capped, because this is not just a key.
     *
     * It becomes the spec filename, the emitted `<id>.spec.ts`, and the
     * `@feature:<id>` tag on every generated test — so an over-long one makes
     * `playwright test` output unreadable for the life of the suite. A live run
     * produced `activity-data-mvpa-split-on-gaq-status-change-within-day`, 56
     * characters. Failing validation here is cheap: the provider retries with
     * the error attached and the second attempt is short.
     */
    id: z
      .string()
      .min(1)
      .max(48, 'id is too long — three or four words, e.g. `unfit-mvpa-column`')
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'id must be kebab-case'),
    title: z.string().min(1),
    priority: FeaturePrioritySchema.default('p1'),
    tags: z.array(z.string()).default([]),
    /** URL hints, when the document names a screen. */
    pages: z.array(z.string()).default([]),
    acceptanceCriteria: z.array(z.string()).default([]),
    negativeCases: z.array(z.string()).default([]),
    /** Preconditions, phrased as a tester would write them. */
    dataNeeds: z.array(z.string()).default([]),
    /** Prose for the spec body: context a planner needs, not a restatement. */
    body: z.string().default(''),
    /**
     * Which requirements this feature covers, quoted from the document.
     *
     * Exists so a reviewer can check the split without re-reading the source.
     * A feature that cites nothing has probably been invented.
     */
    covers: z.array(z.string()).default([]),
  })
  .strict();
export type DraftFeature = z.infer<typeof DraftFeatureSchema>;

export const DraftedKbSchema = z
  .object({
    features: z.array(DraftFeatureSchema),
    entities: z.array(DraftEntitySchema).default([]),
    roles: z.array(DraftRoleSchema).default([]),
    /**
     * Requirements this suite cannot test, and why.
     *
     * The most valuable field here. A card routinely mixes screens this suite
     * drives with ones it cannot — a web portal and a mobile app in the same
     * document — and a generator that silently turned all of it into tests
     * would be worse than one that says which half it skipped.
     */
    outOfScope: z
      .array(z.object({ what: z.string().min(1), why: z.string().min(1) }).strict())
      .default([]),
    /** Anything ambiguous enough that guessing would be wrong. */
    openQuestions: z.array(z.string()).default([]),
  })
  .strict();
export type DraftedKb = z.infer<typeof DraftedKbSchema>;
