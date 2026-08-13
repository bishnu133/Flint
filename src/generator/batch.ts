import type { ScreenModel } from '../schemas/screen-model.js';
import type { TestPlan } from '../schemas/test-plan.js';
import { emitFeature, type DegradedCase, type EmittedFile } from './emitter.js';
import { mergePageObjectRecords, type StoredPageObject } from './page-object-store.js';
import type { Dialect } from './dialects/types.js';
import { silentLogger, type Logger } from '../shared/logger.js';

/**
 * Emit several features as one unit.
 *
 * `flint generate <feature>` gates one feature at a time against the suite as
 * it currently stands. That is right for a single feature and wrong for a full
 * pipeline run, and the difference cost the operator two failed runs:
 *
 *   generate cart  -> re-emits the page objects login also uses, drops locators
 *                     whose elements the Screen Model no longer has, and the
 *                     compile gate fails on login.spec.ts — a file that run
 *                     never touched
 *
 * Reordering only moves the problem: whichever feature goes first meets the
 * others' un-regenerated specs. There is no safe order, because the unit being
 * checked is wrong. When every feature is being regenerated anyway, the thing
 * that must compile is the **whole suite afterwards**, not each feature against
 * a half-updated one.
 *
 * So this emits every feature in memory, threading the page-object records
 * through so features sharing a page still share its locators, and hands back
 * one combined file set for a single gate. Nothing is written until that gate
 * passes, which keeps the Phase 4 guarantee — a suite is never left in a state
 * Flint knows does not compile.
 */

export interface BatchFeature {
  featureId: string;
  plan: TestPlan;
  /** The feature spec's human title, for the `describe` block. */
  title: string;
}

export interface BatchEmitOptions {
  features: BatchFeature[];
  model: ScreenModel;
  dialect: Dialect;
  /** Records from previous runs. Threaded and grown across the batch. */
  existingPageObjects: StoredPageObject[];
  logger?: Logger;
}

export interface BatchFeatureResult {
  featureId: string;
  /** Cases emitted as fixme/skip, and why. */
  degraded: DegradedCase[];
  skippedDuplicates: string[];
  pageObjects: string[];
  /** Tests that will actually run, after duplicates and degradation. */
  liveTests: number;
}

export interface BatchEmitResult {
  /**
   * Every file the batch wants written, deduplicated by path.
   *
   * Two features touching one page emit that page object twice; the later one
   * carries both features' locators because the records were threaded, so the
   * last write for a path is the complete one.
   */
  files: EmittedFile[];
  /** The merged record to store once the write succeeds. */
  pageObjectRecords: StoredPageObject[];
  perFeature: BatchFeatureResult[];
  /**
   * Features whose plan is entirely duplicates.
   *
   * In a batch this is not automatically the "would empty a spec" emergency
   * that `flint generate` refuses on: another feature in the *same* batch may
   * legitimately have taken over the coverage. The caller decides, with the
   * whole batch in view.
   */
  fullyDuplicated: string[];
}

export function emitBatch(options: BatchEmitOptions): BatchEmitResult {
  const logger = options.logger ?? silentLogger();

  // Path -> file. A later feature's version of a shared page object supersedes
  // the earlier one, and because records are threaded it is a superset.
  const byPath = new Map<string, EmittedFile>();
  const perFeature: BatchFeatureResult[] = [];
  const fullyDuplicated: string[] = [];
  let records = options.existingPageObjects;

  for (const feature of options.features) {
    const result = emitFeature({
      plan: feature.plan,
      model: options.model,
      dialect: options.dialect,
      title: feature.title,
      existingPageObjects: records,
      logger,
    });

    for (const file of result.files) byPath.set(file.path, file);
    records = mergePageObjectRecords(records, result.pageObjectRecords);

    const emitted = feature.plan.cases.length - result.skippedDuplicates.length;
    perFeature.push({
      featureId: feature.featureId,
      degraded: result.degraded,
      skippedDuplicates: result.skippedDuplicates,
      pageObjects: result.pageObjects,
      liveTests: emitted - result.degraded.length,
    });
    if (feature.plan.cases.length > 0 && emitted === 0) fullyDuplicated.push(feature.featureId);
  }

  return {
    // Sorted so a batch is byte-identical whatever order the features arrived
    // in — the same determinism rule the emitter follows.
    files: [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)),
    pageObjectRecords: records,
    perFeature,
    fullyDuplicated,
  };
}
