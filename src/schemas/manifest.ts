import { z } from 'zod';

/**
 * The Suite Manifest — what a Bubblegum suite already knows how to do.
 *
 * The Playwright dialect stops the model inventing selectors by checking every
 * `elementRef` against the Screen Model. The Bubblegum dialect has no selectors
 * to check, so the same principle needs different evidence: the generator must
 * not invent a *flow*. Ask for a test that logs in and the model will happily
 * call `loginToPortal()` when the function is named `loginFlow()`, and the
 * result compiles, imports nothing that exists, and fails at run time.
 *
 * The manifest is that evidence. It is derived by scanning the suite — never
 * authored, never appended to by hand. The code is the truth; this is an index
 * of it, regenerated on every run. That distinction is the whole design: a
 * hand-maintained inventory goes stale the first time somebody renames a
 * function, and a stale inventory is worse than none, because the referential
 * check would then reject valid code and accept invented code.
 *
 * Structure follows the four-layer pattern a Bubblegum suite uses in place of
 * page objects: data -> flow -> test, over shared helpers.
 */

/** What a flow function is for. Derived from its name, never from a model. */
export const FlowKindSchema = z.enum([
  /** `loginFlow`, `logoutFlow` — session lifecycle. */
  'auth',
  /** `navigateToBadges` — moves the app to a screen. */
  'navigate',
  /** `createBadge` — makes something, usually returns its name. */
  'create',
  /** `validateBadge`, `verifyStatus` — asserts without changing state. */
  'validate',
  /**
   * `approveActivityByPM`, `submitForApproval` — moves an entity through a
   * workflow without creating it.
   *
   * Its own kind because admin portals are full of these and they are the
   * opposite of `create`: the entity already exists, and the flow's whole
   * purpose is the state change. Lumping them into `create` would offer the
   * planner an approval flow when it asked how to make something.
   */
  'transition',
  /** `cleanup` — tears down. */
  'cleanup',
  'other',
]);
export type FlowKind = z.infer<typeof FlowKindSchema>;

export const FlowParamSchema = z
  .object({
    name: z.string().min(1),
    /** Type as written in the source, e.g. `Bubblegum`, `Page`, `Credentials`. */
    type: z.string(),
  })
  .strict();

export const FlowEntrySchema = z
  .object({
    /** `<file stem>.<export>`, e.g. `login.loginFlow`. Stable and unique. */
    id: z.string().min(1),
    file: z.string().min(1),
    exportName: z.string().min(1),
    /** File stem without the `.flow` suffix — the feature this belongs to. */
    domain: z.string().min(1),
    kind: FlowKindSchema,
    /**
     * First line of the JSDoc comment.
     *
     * This is the semantic layer, and it is free: a suite following the
     * four-layer convention already documents every flow ("Navigates to the
     * Badges page from any page in the portal."). Reading it beats asking a
     * model to infer intent from a function name.
     */
    summary: z.string().optional(),
    params: z.array(FlowParamSchema),
    /** Return type as written, e.g. `Promise<string>`. */
    returns: z.string(),
    /**
     * The `act`/`verify`/`observe` strings this flow issues, in source order.
     *
     * Two jobs. They teach the generator the suite's house phrasing — "Click
     * the + Create badge button", not "Click Create" — and on a screen the
     * crawler cannot reach they are the only evidence of what labels exist.
     * Interpolations are preserved as `${...}` so a reader can tell a literal
     * from a value.
     */
    phrases: z.array(z.string()),
    /** Test files importing this flow, relative to the suite root. */
    usedBy: z.array(z.string()),
  })
  .strict();
export type FlowEntry = z.infer<typeof FlowEntrySchema>;

export const DataEntrySchema = z
  .object({
    id: z.string().min(1),
    file: z.string().min(1),
    exportName: z.string().min(1),
    domain: z.string().min(1),
    /** Top-level keys of the exported object, so the planner can name fields. */
    keys: z.array(z.string()),
  })
  .strict();
export type DataEntry = z.infer<typeof DataEntrySchema>;

export const HelperEntrySchema = z
  .object({
    id: z.string().min(1),
    file: z.string().min(1),
    exportName: z.string().min(1),
    summary: z.string().optional(),
  })
  .strict();
export type HelperEntry = z.infer<typeof HelperEntrySchema>;

/**
 * A credential getter. Kept separate from data because the generator picks one
 * per feature from the spec's `role`, and inventing one means a test that
 * cannot log in.
 */
export const CredentialEntrySchema = z
  .object({
    getter: z.string().min(1),
    file: z.string().min(1),
    /** Role name parsed from the getter's JSDoc or its name. */
    role: z.string().optional(),
  })
  .strict();
export type CredentialEntry = z.infer<typeof CredentialEntrySchema>;

/** A data-access class the suite uses for setup or teardown. */
export const RepositoryEntrySchema = z
  .object({
    className: z.string().min(1),
    file: z.string().min(1),
    methods: z.array(z.string()),
  })
  .strict();
export type RepositoryEntry = z.infer<typeof RepositoryEntrySchema>;

export const ManifestWarningSchema = z.object({ file: z.string(), message: z.string() }).strict();

export const SuiteManifestSchema = z
  .object({
    /** Bumped when the scanner's output shape changes. */
    version: z.literal(1),
    generatedAt: z.string().min(1),
    /** Suite root the scan covered, relative to the project root. */
    suiteDir: z.string(),
    flows: z.array(FlowEntrySchema),
    data: z.array(DataEntrySchema),
    helpers: z.array(HelperEntrySchema),
    credentials: z.array(CredentialEntrySchema),
    repositories: z.array(RepositoryEntrySchema),
    /** Files that could not be parsed. A bad file never fails the scan. */
    warnings: z.array(ManifestWarningSchema),
  })
  .strict();
export type SuiteManifest = z.infer<typeof SuiteManifestSchema>;

/** True when nothing has been built yet — the greenfield case. */
export function isEmptyManifest(manifest: SuiteManifest): boolean {
  return (
    manifest.flows.length === 0 && manifest.data.length === 0 && manifest.credentials.length === 0
  );
}
