import { emitBatch, type BatchFeature } from '../generator/batch.js';
import type { EmittedFile, StaleLocators } from '../generator/emitter.js';
import type { StoredPageObject } from '../generator/page-object-store.js';
import type { Dialect } from '../generator/dialects/types.js';
import type { ScreenModel } from '../schemas/screen-model.js';
import { silentLogger, type Logger } from '../shared/logger.js';

/**
 * Re-point page objects at a changed UI, leaving every spec alone.
 *
 * This is the narrow repair drift mode offers. When an application renames a
 * `data-test` attribute or moves a button, the tests are still correct — the
 * *addresses* are stale. Regenerating page objects from the new Screen Model
 * fixes the addresses; regenerating the specs would also rewrite assertions
 * and titles nobody asked to change, and would throw away hand edits the
 * managed-marker system exists to protect.
 *
 * Two properties make this safe rather than merely convenient:
 *
 *  - **The specs are the check.** They are not rewritten, so running the
 *    compile gate over the new page objects plus the untouched specs asks
 *    exactly the right question: do the tests still work against the new
 *    addresses? If a locator disappeared, the gate fails and nothing is
 *    written — the drift needed a re-plan, not a re-point.
 *  - **Targeting falls out of the write layer.** Every page object is
 *    re-emitted, but `planWrites` reports a byte-identical file as `unchanged`
 *    and never rewrites it. So only genuinely affected files move, without
 *    this module having to guess which ones those are — a guess that would be
 *    wrong the moment a shared page object was involved.
 */

export interface RegenerateOptions {
  /** Every feature with a stored plan; page objects are a union across them. */
  features: BatchFeature[];
  /** The **new** model — the one the crawl just produced. */
  model: ScreenModel;
  dialect: Dialect;
  existingPageObjects: StoredPageObject[];
  logger?: Logger;
}

export interface RegenerateResult {
  /** Page-object files only. Specs are deliberately excluded. */
  files: EmittedFile[];
  pageObjectRecords: StoredPageObject[];
  /**
   * Locators that could not be re-emitted because the element is gone.
   *
   * A spec still referencing one of these is what the compile gate will trip
   * on, so this is the explanation to print when it does.
   */
  staleLocators: StaleLocators[];
}

export function regeneratePageObjects(options: RegenerateOptions): RegenerateResult {
  const logger = options.logger ?? silentLogger();

  const batch = emitBatch({
    features: options.features,
    model: options.model,
    dialect: options.dialect,
    existingPageObjects: options.existingPageObjects,
    logger,
  });

  const staleByClass = new Map<string, StaleLocators>();
  for (const feature of batch.perFeature) {
    for (const stale of feature.staleLocators) {
      const existing = staleByClass.get(stale.className);
      if (existing === undefined) {
        staleByClass.set(stale.className, stale);
        continue;
      }
      staleByClass.set(stale.className, {
        className: stale.className,
        elementIds: unique([...existing.elementIds, ...stale.elementIds]),
        features: unique([...existing.features, ...stale.features]),
      });
    }
  }

  return {
    files: batch.files.filter((file) => file.kind === 'page-object'),
    pageObjectRecords: batch.pageObjectRecords,
    staleLocators: [...staleByClass.values()].sort((a, b) =>
      a.className.localeCompare(b.className),
    ),
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}
