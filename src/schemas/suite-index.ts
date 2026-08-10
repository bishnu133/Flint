import { z } from 'zod';

/**
 * SuiteIndex schema — master plan B4 (LOCKED once written).
 *
 * A static-scan model of the existing `e2e/` suite (built with ts-morph in
 * Phase 2) so new tests extend and reuse rather than duplicate. Tracks which
 * files are Flint-managed vs hand-edited via the managed-marker hash.
 */

export const PageObjectMethodSchema = z
  .object({
    name: z.string().min(1),
    /** Selector strings referenced by this method (for drift mapping). */
    selectorsUsed: z.array(z.string()),
  })
  .strict();

export const PageObjectSchema = z
  .object({
    className: z.string().min(1),
    file: z.string().min(1),
    methods: z.array(PageObjectMethodSchema),
    /** All selector strings used anywhere in the page object. */
    selectorsUsed: z.array(z.string()),
  })
  .strict();
export type PageObject = z.infer<typeof PageObjectSchema>;

export const SpecFileSchema = z
  .object({
    file: z.string().min(1),
    testTitles: z.array(z.string()),
    tags: z.array(z.string()),
  })
  .strict();
export type SpecFile = z.infer<typeof SpecFileSchema>;

export const FixtureSchema = z
  .object({
    name: z.string().min(1),
    file: z.string().min(1),
  })
  .strict();

export const DataFactorySchema = z
  .object({
    name: z.string().min(1),
    file: z.string().min(1),
  })
  .strict();

/** featureId -> test ids covering it. */
export const CoverageMapSchema = z.record(z.string(), z.array(z.string()));
export type CoverageMap = z.infer<typeof CoverageMapSchema>;

export const SuiteIndexSchema = z
  .object({
    generatedAt: z.string().datetime(),
    suiteDir: z.string().min(1),
    pageObjects: z.array(PageObjectSchema),
    specs: z.array(SpecFileSchema),
    fixtures: z.array(FixtureSchema),
    dataFactories: z.array(DataFactorySchema),
    coverageMap: CoverageMapSchema,
    /** Files with a valid, matching @flint:managed marker. */
    managedFiles: z.array(z.string()),
    /** Managed files whose content hash no longer matches (hand-edited). */
    handEditedFiles: z.array(z.string()),
  })
  .strict();
export type SuiteIndex = z.infer<typeof SuiteIndexSchema>;
