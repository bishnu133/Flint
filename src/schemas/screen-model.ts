import { z } from 'zod';
import { SELECTOR_STRATEGIES } from '../shared/selector-ranking.js';

/**
 * ScreenModel schema — master plan B4 (LOCKED once written).
 *
 * A machine-built model of real pages and their interactive elements, with
 * ranked, verified selector candidates. The generator may only reference
 * elements that exist here — the LLM never invents a selector.
 *
 * Fields beyond the abridged B4 sketch (recorded in PHASE_NOTES.md):
 *   - top-level ScreenModel container (version/baseUrl/role/pages/...)
 *   - Element.framePath (iframe support, Phase 1)
 *   - Page.lang, Page.role, Page.unreachable (i18n / multi-role / CAPTCHA cases)
 */

export const SelectorStrategySchema = z.enum(SELECTOR_STRATEGIES);
export type SelectorStrategyName = z.infer<typeof SelectorStrategySchema>;

export const SelectorCandidateSchema = z
  .object({
    strategy: SelectorStrategySchema,
    value: z.string().min(1, 'selector value must not be empty'),
    score: z.number().min(0),
    unique: z.boolean(),
    verified: z.boolean(),
  })
  .strict();
export type SelectorCandidate = z.infer<typeof SelectorCandidateSchema>;

export const BoundingBoxSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    width: z.number().min(0),
    height: z.number().min(0),
  })
  .strict();
export type BoundingBox = z.infer<typeof BoundingBoxSchema>;

export const ElementStatesSchema = z
  .object({
    visible: z.boolean(),
    enabled: z.boolean(),
  })
  .strict();

/**
 * How an element came to exist on the page.
 *
 * Added after Phase 1 with explicit operator approval (2026-08-11) — the only
 * change to this file since the schemas were locked. Optional and additive, so
 * Screen Models written before it still parse; absent means `page`.
 *
 * Without this the model says *what* an element is but never *how to reach it*,
 * which showed up three ways: `--validate` reporting flow-captured elements as
 * drift, the interaction pass losing which trigger reveals a menu item, and the
 * Emitter being able to reference either without emitting the precondition.
 */
export const ElementProvenanceSchema = z.discriminatedUnion('kind', [
  /** Present on page load. The default, and the only kind the Emitter may use freely. */
  z.object({ kind: z.literal('page') }).strict(),
  /** Exists only after clicking `openerElementId` — a menu item or modal control. */
  z
    .object({
      kind: z.literal('revealed'),
      openerElementId: z.string().min(1, 'openerElementId must name the element that reveals this'),
    })
    .strict(),
  /** Exists only in the state a flow script drives the app into. */
  z
    .object({
      kind: z.literal('flow'),
      flowId: z.string().min(1),
      /** Which `capture()` call in that flow, 0-based. */
      step: z.number().int().min(0),
    })
    .strict(),
]);
export type ElementProvenance = z.infer<typeof ElementProvenanceSchema>;

export const ElementSchema = z
  .object({
    id: z.string().min(1),
    role: z.string().min(1),
    name: z.string(),
    testId: z.string().optional(),
    domId: z.string().optional(),
    text: z.string().optional(),
    tagName: z.string().min(1),
    boundingBox: BoundingBoxSchema,
    states: ElementStatesSchema,
    selectorCandidates: z.array(SelectorCandidateSchema),
    /** Frame path for elements inside same-origin iframes (Phase 1). */
    framePath: z.array(z.string()).optional(),
    /** How this element came to exist. Absent = present on page load. */
    provenance: ElementProvenanceSchema.optional(),
    /**
     * The element sits inside a dialog. Approved 2026-08-18.
     *
     * Needed by the Bubblegum dialect, where a step is a sentence rather than a
     * selector. On an ordinary page `act(page, 'click the Save button')` is
     * enough; the moment a modal is open there are two Save buttons and the
     * sentence has to say `'... in dialog'`, exactly as a person writing the
     * step by hand would. Nothing else in the model carries that fact:
     * `provenance.revealed` says an element appeared after a click, which is
     * equally true of a dropdown item, and a dialog open on page load has no
     * provenance at all.
     *
     * Deliberately not `section`. The original proposal also recorded the
     * nearest heading, so a repeated label could be qualified as "in the
     * Billing section". That was rejected: the dialog case is the one that
     * actually breaks, and a heading-derived qualifier is a guess about
     * document structure that reads as fact in a generated sentence.
     */
    inDialog: z.boolean().optional(),
  })
  .strict();
export type Element = z.infer<typeof ElementSchema>;

/** How a page was first reached during exploration. */
export const LinkRefSchema = z
  .object({
    kind: z.literal('link'),
    fromPageId: z.string().optional(),
    href: z.string().min(1),
  })
  .strict();

export const FlowRefSchema = z
  .object({
    kind: z.literal('flow'),
    flowId: z.string().min(1),
    step: z.number().int().min(0).optional(),
  })
  .strict();

export const ReachedViaSchema = z.discriminatedUnion('kind', [LinkRefSchema, FlowRefSchema]);
export type ReachedVia = z.infer<typeof ReachedViaSchema>;

export const PageSchema = z
  .object({
    id: z.string().min(1),
    url: z.string().url('page url must be an absolute URL'),
    /** Normalized pattern, e.g. `/order/:id`, used to collapse parameterised URLs. */
    urlPattern: z.string().min(1),
    title: z.string(),
    screenshotPath: z.string().optional(),
    reachedVia: ReachedViaSchema,
    elements: z.array(ElementSchema),
    navTargets: z.array(z.string()),
    capturedAt: z.string().datetime({ message: 'capturedAt must be an ISO datetime' }),
    appVersionHint: z.string().optional(),
    /** BCP-47 language tag captured from <html lang>, for i18n-aware ranking. */
    lang: z.string().optional(),
    /** Role this page was captured under, when `roles[]` is configured. */
    role: z.string().optional(),
    /** Set when the page was detected but could not be explored (CAPTCHA, etc.). */
    unreachable: z.object({ reason: z.string() }).strict().optional(),
  })
  .strict();
export type Page = z.infer<typeof PageSchema>;

export const ScreenModelSchema = z
  .object({
    /** Monotonic version string bumped on each explore run. */
    version: z.string().min(1),
    baseUrl: z.string().url(),
    /** Role this model was captured for, when multi-role exploration is used. */
    role: z.string().optional(),
    capturedAt: z.string().datetime(),
    appVersionHint: z.string().optional(),
    pages: z.array(PageSchema),
  })
  .strict();
export type ScreenModel = z.infer<typeof ScreenModelSchema>;
