import { z } from 'zod';

/**
 * Application knowledge — the half of a test that no crawler can discover.
 *
 * The Screen Model knows what a page looks like. The manifest knows what the
 * suite can already do. Neither knows that GAQ means Get Active Questionnaire,
 * that its unfit value is 3, that a test reaches that state through
 * `UserRepository.updateGAQ`, or that a user may only change it once a day.
 * Those are facts about the business, and they come from a human.
 *
 * ## Why this lives in `kb/app/` and not in feature-spec frontmatter
 *
 * "How does a test put a user in GAQ-unfit state" is a property of the
 * application, not of any one feature — a dozen specs will need it. Recording
 * it per spec would copy the same answer into a dozen files and guarantee they
 * drift. It is written once here, and specs refer to it through the
 * `dataNeeds` field the feature schema already has.
 *
 * That also means B2 required no change to the LOCKED Phase 0 schemas, which
 * is worth more than the convenience of a `setup:` key would have been.
 *
 * ## Why it is worth writing at all
 *
 * These files are the difference between a planner that guesses and one that
 * refuses. Every state below is checked against the manifest before generation:
 * a `repository` that names a method nobody implemented fails the check, the
 * same way an invented selector fails today.
 */

/** How a test drives the application into a particular state. */
export const StateSetupSchema = z
  .object({
    /**
     * `UserRepository.updateGAQ` — checked against the manifest, so a typo or
     * a method somebody deleted is caught before any code is generated.
     */
    repository: z.string().min(1).optional(),
    /** `badge-creation.createBadge` — an existing flow reaches this state. */
    flow: z.string().min(1).optional(),
    /** A service call, for state neither the DB nor the UI can set. */
    api: z.string().min(1).optional(),
    /**
     * Why this state cannot be reached by a test, in plain words.
     *
     * Recording an honest dead end is the point of the field. Left blank, the
     * planner has no way to tell "nobody has written this down yet" from
     * "there is no way to do this", and it will cheerfully plan a test for the
     * second.
     */
    unreachable: z.string().min(1).optional(),
    /** Anything a human needs to know — timing, side effects, ordering. */
    note: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (s) =>
      s.repository !== undefined ||
      s.flow !== undefined ||
      s.api !== undefined ||
      s.unreachable !== undefined,
    { message: 'a state needs one of: repository, flow, api, or unreachable' },
  );
export type StateSetup = z.infer<typeof StateSetupSchema>;

export const EntityDocSchema = z
  .object({
    /** Stable id, kebab-case. Matched against `dataNeeds` prose. */
    entity: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'entity must be kebab-case (a-z, 0-9, hyphen)'),
    /**
     * Other names this is called in specs and JIRA cards.
     *
     * A card says "fitness status", the KB file is called `gaq`, and without
     * aliases the two never meet. Cheap to write, and it is the difference
     * between a gap report that is useful and one that cries wolf.
     */
    aliases: z.array(z.string()).default([]),
    /** State name -> how to reach it. */
    states: z.record(z.string(), StateSetupSchema).default({}),
  })
  .strict();
export type EntityDoc = z.infer<typeof EntityDocSchema>;

/** A role a test can act as, and the credential getter that provides it. */
export const RoleDocSchema = z
  .object({
    id: z.string().min(1),
    /** `getBAPBadgeSupportCredentials` — checked against the manifest. */
    credentials: z.string().min(1).optional(),
    /**
     * Why a human has to confirm `credentials` before anything runs.
     *
     * `flint draft` matches a role the document describes ("Vendor Admins")
     * against the getters the suite exports, and often more than one could fit.
     * The name resolves, so the integrity check passes and every test built on
     * it runs — as the wrong user, failing on an access assertion that is
     * actually correct. That is a day lost to a question nobody was asked.
     *
     * A guess is therefore written *with* this field rather than silently. It
     * blocks nothing; it is reported by `flint kb` until somebody deletes the
     * line, which is the act of confirming.
     */
    review: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    aliases: z.array(z.string()).default([]),
  })
  .strict();
export type RoleDoc = z.infer<typeof RoleDocSchema>;

/** One domain term and what it means. */
export const GlossaryTermSchema = z
  .object({
    term: z.string().min(1),
    definition: z.string().min(1),
    aliases: z.array(z.string()).default([]),
  })
  .strict();
export type GlossaryTerm = z.infer<typeof GlossaryTermSchema>;

/** Everything read from `kb/app/`, assembled. */
export const AppKnowledgeSchema = z
  .object({
    entities: z.array(EntityDocSchema),
    roles: z.array(RoleDocSchema),
    glossary: z.array(GlossaryTermSchema),
    /** Free prose from `rules.md` — constraints the planner must respect. */
    rules: z.array(z.string()),
    /** Files that could not be parsed. A bad file never fails the read. */
    warnings: z.array(z.object({ file: z.string(), message: z.string() }).strict()),
  })
  .strict();
export type AppKnowledge = z.infer<typeof AppKnowledgeSchema>;

export const EMPTY_KNOWLEDGE: AppKnowledge = {
  entities: [],
  roles: [],
  glossary: [],
  rules: [],
  warnings: [],
};
