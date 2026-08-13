import { z } from 'zod';

/**
 * Flint project configuration schema (`flint.config.ts` in a target
 * project). LOCKED after Phase 0.
 *
 * Every field has a friendly failure message so an invalid config produces a
 * zod error naming the bad key (see `src/config/load.ts`), never a stack trace.
 * Sensible defaults are applied where the master plan does not mandate a value;
 * defaults chosen are recorded in PHASE_NOTES.md.
 */

export const EnvClassSchema = z.enum(['test', 'dev', 'staging', 'production']);
export type EnvClass = z.infer<typeof EnvClassSchema>;

/** Authentication strategy for exploration and generated suites. */
export const AuthConfigSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }).strict(),
  z
    .object({
      mode: z.literal('storageState'),
      storageStatePath: z.string().min(1, 'storageStatePath is required for storageState auth'),
    })
    .strict(),
  z
    .object({
      mode: z.literal('loginScript'),
      loginScriptPath: z.string().min(1, 'loginScriptPath is required for loginScript auth'),
    })
    .strict(),
  z
    .object({
      mode: z.literal('credentials'),
      username: z.string().min(1),
      password: z.string().min(1),
      loginUrl: z.string().url().optional(),
    })
    .strict(),
]);
export type AuthConfig = z.infer<typeof AuthConfigSchema>;

/** URL normalization rule to collapse parameterised URLs (e.g. /order/:id). */
export const UrlNormalizeRuleSchema = z
  .object({
    pattern: z.string().min(1),
    replacement: z.string().min(1),
  })
  .strict();

export const ExplorerConfigSchema = z
  .object({
    /** V1 = crawl. agent / crawl-then-agent land in V2 but the enum is stable. */
    mode: z.enum(['crawl', 'agent', 'crawl-then-agent']).default('crawl'),
    urlPatterns: z
      .object({
        include: z.array(z.string()).default([]),
        exclude: z.array(z.string()).default([]),
        normalize: z.array(UrlNormalizeRuleSchema).default([]),
      })
      .strict()
      .default({ include: [], exclude: [], normalize: [] }),
    maxPages: z.number().int().positive('explorer.maxPages must be a positive integer').default(50),
    maxDepth: z.number().int().positive('explorer.maxDepth must be a positive integer').default(5),
    /** Actions the crawler must never trigger (buttons matching these). */
    dangerousActionPatterns: z
      .array(z.string())
      .default(['logout', 'delete', 'submit', 'pay', 'remove']),
    /** When true, selector ranking demotes text-based strategies. */
    i18n: z.boolean().default(false),
    /**
     * The attribute this application marks test hooks with.
     *
     * Drives both halves of the top-ranked strategy: which elements the capture
     * net pulls in, and whether a `testid` candidate (score 100, the highest in
     * the LOCKED ranking) can be built at all. An app that uses `data-test` and
     * leaves this at the default gets no test-id selectors whatsoever, and
     * silently falls back to role and CSS — which is exactly the fragility the
     * ranking exists to avoid.
     */
    testIdAttribute: z
      .string()
      .min(1, 'explorer.testIdAttribute cannot be empty (e.g. "data-testid" or "data-test")')
      .default('data-testid'),
    /** Roles to build a Screen Model per; empty = single anonymous model. */
    roles: z.array(z.string()).default([]),
    /** Patterns that mark a page as bot-blocked / unreachable. */
    captchaPatterns: z.array(z.string()).default([]),
    waitStrategy: z.enum(['networkidle', 'domcontentloaded', 'load']).default('networkidle'),
  })
  .strict()
  .default({});

export const ModelsConfigSchema = z
  .object({
    /** Stronger model for planning (Stage A). */
    planner: z.string().min(1),
    /** Cheaper model for code emission (Stage B). */
    coder: z.string().min(1),
    /** Stronger model for repair (Phase 5). */
    repair: z.string().min(1),
  })
  .strict();
export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;

export const TokenBudgetsSchema = z
  .object({
    /** Context budget for the planner prompt. */
    plan: z.number().int().positive().default(60_000),
    /** Context budget for each code-emission call. */
    generate: z.number().int().positive().default(40_000),
    /** Context budget for each repair call. */
    repair: z.number().int().positive().default(30_000),
  })
  .strict()
  .default({});

export const DebugConfigSchema = z
  .object({
    /** Log raw prompts (off by default — prompts may contain secrets). */
    logPrompts: z.boolean().default(false),
    verbose: z.boolean().default(false),
  })
  .strict()
  .default({});

export const DialectSchema = z.enum(['playwright-pom', 'bubblegum']);
export type Dialect = z.infer<typeof DialectSchema>;

export const FlintConfigSchema = z
  .object({
    baseUrl: z.string().url('baseUrl must be an absolute URL (e.g. https://app.example.com)'),
    envClass: EnvClassSchema,
    /** Directory of the generated suite, relative to the project root. */
    suiteDir: z.string().min(1).default('e2e'),
    /** Directory of the knowledge base. */
    kbDir: z.string().min(1).default('kb'),
    auth: AuthConfigSchema.default({ mode: 'none' }),
    explorer: ExplorerConfigSchema,
    models: ModelsConfigSchema,
    dialect: DialectSchema.default('playwright-pom'),
    tokenBudgets: TokenBudgetsSchema,
    debug: DebugConfigSchema,
  })
  .strict();

/** Parsed config with all defaults applied. */
export type FlintConfig = z.infer<typeof FlintConfigSchema>;
/** Config as written by a user, before defaults are applied. */
export type FlintConfigInput = z.input<typeof FlintConfigSchema>;
