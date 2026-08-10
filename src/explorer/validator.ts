import type { BrowserContext, Frame, Page as PwPage } from '@playwright/test';
import type { ScreenModel, SelectorCandidate } from '../schemas/screen-model.js';
import { silentLogger, type Logger } from '../shared/logger.js';
import { locatorFor } from './extractor.js';
import { pickBest } from './selector-ranker.js';
import { waitForDomStable } from './wait.js';

/**
 * Replay validator (`flint explore --validate`).
 *
 * Re-opens every page in a stored Screen Model and re-resolves the selector the
 * Emitter would actually use — the highest-scored verified-unique candidate.
 * The break rate is the Phase 1 exit metric (≥95% must re-resolve) and, run
 * later against a changed app, it is an early warning that generated tests are
 * about to start failing.
 */

export interface BrokenSelector {
  pageId: string;
  urlPattern: string;
  elementId: string;
  strategy: SelectorCandidate['strategy'];
  value: string;
  /** How many nodes it matched: 0 = gone, >1 = ambiguous. */
  matched: number;
}

export interface ValidationReport {
  pagesChecked: number;
  pagesUnreachable: string[];
  /** Elements that had a usable selector stored. */
  selectorsChecked: number;
  /** Of those, how many still resolve to exactly one node. */
  selectorsResolved: number;
  /** Elements with no verified-unique candidate at all — already unusable. */
  elementsWithoutUsableSelector: number;
  broken: BrokenSelector[];
  /** selectorsResolved / selectorsChecked, or 1 when nothing was checked. */
  resolveRate: number;
}

export interface ValidateOptions {
  logger?: Logger;
  /** Per-navigation timeout. */
  timeoutMs?: number;
}

export async function validateModel(
  context: BrowserContext,
  model: ScreenModel,
  options: ValidateOptions = {},
): Promise<ValidationReport> {
  const logger = options.logger ?? silentLogger();
  const report: ValidationReport = {
    pagesChecked: 0,
    pagesUnreachable: [],
    selectorsChecked: 0,
    selectorsResolved: 0,
    elementsWithoutUsableSelector: 0,
    broken: [],
    resolveRate: 1,
  };

  const page = await context.newPage();
  try {
    for (const modelPage of model.pages) {
      try {
        await page.goto(modelPage.url, {
          waitUntil: 'domcontentloaded',
          ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
        });
        // Settle exactly as the crawler did before capturing. Without this a
        // client-rendered page is measured while its shell is still empty and
        // every selector on it is reported as broken — false drift, on every
        // SPA, every run.
        await waitForDomStable(page);
      } catch {
        report.pagesUnreachable.push(modelPage.url);
        logger.warn({ url: modelPage.url }, 'validate: page unreachable');
        continue;
      }
      report.pagesChecked += 1;

      for (const element of modelPage.elements) {
        const best = pickBest(element.selectorCandidates);
        if (best === undefined) {
          // Nothing usable was ever stored — counted separately so the resolve
          // rate measures drift, not gaps that existed at capture time.
          report.elementsWithoutUsableSelector += 1;
          continue;
        }
        report.selectorsChecked += 1;
        // Resolve in the frame the element was captured in. An iframe element
        // was verified inside its child frame; checking the main frame would
        // report every such element as broken on every run.
        const frame = frameFor(page, element.framePath);
        const matched =
          frame === undefined
            ? 0
            : await locatorFor(frame, best)
                .count()
                .catch(() => 0);
        if (matched === 1) {
          report.selectorsResolved += 1;
        } else {
          report.broken.push({
            pageId: modelPage.id,
            urlPattern: modelPage.urlPattern,
            elementId: element.id,
            strategy: best.strategy,
            value: best.value,
            matched,
          });
        }
      }
    }
  } finally {
    await page.close().catch(() => undefined);
  }

  report.resolveRate =
    report.selectorsChecked === 0 ? 1 : report.selectorsResolved / report.selectorsChecked;
  return report;
}

/**
 * Find the frame an element was captured in. `framePath` stores what the
 * extractor recorded: `frame.name() || frame.url()` — match either. Undefined
 * means the frame no longer exists, which is itself drift.
 */
function frameFor(page: PwPage, framePath: string[] | undefined): Frame | undefined {
  if (framePath === undefined || framePath.length === 0) return page.mainFrame();
  const key = framePath[0]!;
  return page.frames().find((f) => f !== page.mainFrame() && (f.name() === key || f.url() === key));
}

/** Human-readable summary for the CLI. */
export function formatValidation(report: ValidationReport): string {
  const pct = (report.resolveRate * 100).toFixed(1);
  const lines = [
    `Pages checked:        ${report.pagesChecked}`,
    `Selectors checked:    ${report.selectorsChecked}`,
    `Still resolving:      ${report.selectorsResolved} (${pct}%)`,
  ];
  if (report.elementsWithoutUsableSelector > 0) {
    lines.push(`No usable selector:   ${report.elementsWithoutUsableSelector} (at capture time)`);
  }
  if (report.pagesUnreachable.length > 0) {
    lines.push(`Unreachable pages:    ${report.pagesUnreachable.length}`);
    for (const url of report.pagesUnreachable) lines.push(`  ! ${url}`);
  }
  if (report.broken.length > 0) {
    lines.push('', 'Broken selectors:');
    for (const b of report.broken) {
      const why = b.matched === 0 ? 'no match' : `${b.matched} matches`;
      lines.push(`  ${b.urlPattern}  ${b.elementId}  [${b.strategy}] ${b.value} — ${why}`);
    }
  }
  return lines.join('\n');
}
