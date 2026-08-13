import type { Element, ScreenModel } from '../schemas/screen-model.js';
import type { SuiteIndex } from '../schemas/suite-index.js';
import type { ScreenModelDiff } from '../explorer/screen-model-store.js';
import type { StoredPageObject } from '../generator/page-object-store.js';
import { splitTitleTags } from '../generator/emitter.js';

/**
 * Drift impact: which tests a UI change is going to break.
 *
 * `flint explore --diff` already says what moved in the application. On its own
 * that is a wall of element ids — true, and almost useless, because the
 * question an operator actually has is "do I need to do anything about this?".
 * This module answers that by walking the change back through the suite:
 *
 *     changed element -> page object that addresses it -> feature -> tests
 *
 * Two independent links, on purpose:
 *
 *  - **record**: `.flint/page-objects.json` says which element ids each
 *    generated page object exposes. Exact, and it carries the feature ids, so
 *    it reaches all the way to test titles via the coverage map.
 *  - **selector**: the Suite Index records the literal selector strings each
 *    page object uses. That link works for page objects Flint never generated,
 *    which is the whole reason the index exists.
 *
 * The selector link deliberately ignores `role` candidates. The Phase 2 scan
 * records a call's first string argument, and for `getByRole('button', { name:
 * … })` that is the bare role — matching on it would flag every button in the
 * suite as affected by any button changing. A false "47 tests break" is worse
 * than a quiet miss, because the operator stops reading the report.
 *
 * Nothing here touches the filesystem or a browser: the caller supplies the two
 * models, the index and the records, which is what makes it table-testable.
 */

/**
 * How confident we are that the change breaks the test.
 *
 * - `breaks`   — a selector the suite actually uses is gone. It will not resolve.
 * - `likely`   — the element's identity moved (role, name, test id). Whether the
 *                emitted locator survives depends on which candidate was used.
 * - `possible` — the element is intact but its state changed; a visibility
 *                assertion may now disagree.
 */
export type DriftSeverity = 'breaks' | 'likely' | 'possible';

const SEVERITY_ORDER: Record<DriftSeverity, number> = { breaks: 3, likely: 2, possible: 1 };

export type DriftKind = 'removed' | 'selector-gone' | 'identity-changed' | 'state-changed';

export interface ElementDrift {
  elementId: string;
  pageId: string;
  urlPattern: string;
  kind: DriftKind;
  severity: DriftSeverity;
  /** Human phrasing of what changed, e.g. `name "Login" → "Sign in"`. */
  detail: string;
  /** Selector values this element no longer offers. Empty for state changes. */
  lostSelectors: string[];
}

export interface AffectedPageObject {
  className: string;
  /** Project-relative file, when the Suite Index knows the class. */
  file?: string;
  severity: DriftSeverity;
  drift: ElementDrift[];
  /** Which link found it. Both is common and is the strongest signal. */
  via: Array<'record' | 'selector'>;
}

export interface AffectedTest {
  /** The test title, which is how the coverage map identifies a test. */
  testId: string;
  /** Spec file, when a spec in the index declares that title. */
  file?: string;
  featureId: string;
  severity: DriftSeverity;
  /** Page-object classes that connect this test to the change. */
  through: string[];
}

export interface DriftImpact {
  /** Every change that could matter, worst first. */
  drift: ElementDrift[];
  affectedPageObjects: AffectedPageObject[];
  affectedTests: AffectedTest[];
  /** Changes no page object in the suite maps to — real drift, no impact. */
  unmapped: ElementDrift[];
  /** Elements the app grew. Not breakage: missing coverage. */
  newElements: Array<{ pageId: string; elementId: string }>;
  /** Pages that vanished entirely. Everything addressing them is dead. */
  removedPages: string[];
}

export interface AnalyzeDriftOptions {
  diff: ScreenModelDiff;
  /** The model the suite was generated from — where lost selectors are read. */
  before: ScreenModel;
  index: SuiteIndex;
  records: StoredPageObject[];
}

export function analyzeDrift(options: AnalyzeDriftOptions): DriftImpact {
  const { diff, before, index, records } = options;

  const beforeElements = new Map<string, { element: Element; pageId: string; url: string }>();
  for (const page of before.pages) {
    for (const element of page.elements) {
      beforeElements.set(element.id, { element, pageId: page.id, url: page.urlPattern });
    }
  }

  const drift: ElementDrift[] = [];
  const newElements: Array<{ pageId: string; elementId: string }> = [];

  // A removed page takes every element on it. Expanding it into per-element
  // drift keeps one mapping path instead of two, and the page objects that
  // addressed those elements are exactly what has to be reported.
  for (const pageId of diff.removedPages) {
    const page = before.pages.find((p) => p.id === pageId);
    for (const element of page?.elements ?? []) {
      drift.push({
        elementId: element.id,
        pageId,
        urlPattern: page?.urlPattern ?? pageId,
        kind: 'removed',
        severity: 'breaks',
        detail: `page ${pageId} is gone`,
        lostSelectors: selectorValues(element),
      });
    }
  }

  for (const pageDiff of diff.changedPages) {
    for (const elementId of pageDiff.removedElements) {
      const known = beforeElements.get(elementId);
      drift.push({
        elementId,
        pageId: pageDiff.pageId,
        urlPattern: pageDiff.urlPattern,
        kind: 'removed',
        severity: 'breaks',
        detail: describeElement(known?.element),
        lostSelectors: known === undefined ? [] : selectorValues(known.element),
      });
    }

    for (const elementId of pageDiff.addedElements) {
      newElements.push({ pageId: pageDiff.pageId, elementId });
    }

    for (const change of pageDiff.changedElements) {
      const lost = change.changed
        .filter((c) => c.startsWith('-selector '))
        .map(stripSelectorPrefix);
      const identity = change.changed.filter((c) => IDENTITY_FIELDS.has(c));

      if (lost.length > 0) {
        drift.push({
          elementId: change.elementId,
          pageId: pageDiff.pageId,
          urlPattern: pageDiff.urlPattern,
          kind: 'selector-gone',
          severity: 'breaks',
          detail: `lost ${lost.length} selector(s): ${lost.join(', ')}`,
          lostSelectors: lost,
        });
        continue;
      }
      if (identity.length > 0) {
        drift.push({
          elementId: change.elementId,
          pageId: pageDiff.pageId,
          urlPattern: pageDiff.urlPattern,
          kind: 'identity-changed',
          severity: 'likely',
          detail: `${identity.join(', ')} changed`,
          lostSelectors: [],
        });
        continue;
      }
      if (change.changed.some((c) => c.startsWith('states'))) {
        drift.push({
          elementId: change.elementId,
          pageId: pageDiff.pageId,
          urlPattern: pageDiff.urlPattern,
          kind: 'state-changed',
          severity: 'possible',
          detail: `${change.changed.join(', ')} changed`,
          lostSelectors: [],
        });
      }
      // Anything else — a candidate gained, a score nudged — is not drift a
      // test can trip over, and reporting it trains the operator to skim.
    }
  }

  // ---- map each change onto the suite ------------------------------------
  const byClass = new Map<string, AffectedPageObject>();
  const unmapped: ElementDrift[] = [];
  const recordsByClass = new Map(records.map((r) => [r.className, r]));

  for (const entry of drift) {
    const owners = ownersOf(entry, beforeElements, index, records);
    if (owners.length === 0) {
      unmapped.push(entry);
      continue;
    }
    for (const owner of owners) {
      const severity = severityFor(entry, owner.selectorsUsed);
      const existing = byClass.get(owner.className);
      if (existing === undefined) {
        byClass.set(owner.className, {
          className: owner.className,
          ...(owner.file !== undefined ? { file: owner.file } : {}),
          severity,
          drift: [entry],
          via: [owner.via],
        });
        continue;
      }
      existing.severity = worse(existing.severity, severity);
      if (!existing.drift.includes(entry)) existing.drift.push(entry);
      if (!existing.via.includes(owner.via)) existing.via.push(owner.via);
      if (existing.file === undefined && owner.file !== undefined) existing.file = owner.file;
    }
  }

  // ---- page objects -> features -> tests ---------------------------------
  const testsByKey = new Map<string, AffectedTest>();
  const specFileOf = specLookup(index);

  for (const affected of byClass.values()) {
    const record = recordsByClass.get(affected.className);
    for (const featureId of record?.features ?? []) {
      for (const testId of index.coverageMap[featureId] ?? []) {
        // One test can appear in the coverage map twice: once from the scanned
        // spec (whose title carries the tags the emitter appended) and once
        // from plan history (the planner's bare title). Reporting two tests at
        // risk when there is one is the inflation that gets a report ignored,
        // so they fold together on the bare title.
        const key = `${featureId} ${splitTitleTags(testId).title}`;
        const file = specFileOf(testId);
        const existing = testsByKey.get(key);
        if (existing === undefined) {
          testsByKey.set(key, {
            testId,
            ...(file !== undefined ? { file } : {}),
            featureId,
            severity: affected.severity,
            through: [affected.className],
          });
          continue;
        }
        existing.severity = worse(existing.severity, affected.severity);
        if (!existing.through.includes(affected.className)) {
          existing.through.push(affected.className);
        }
        // Prefer the variant a spec file actually declares — that is the one
        // the operator can open.
        if (existing.file === undefined && file !== undefined) {
          existing.file = file;
          existing.testId = testId;
        }
      }
    }
  }

  return {
    drift: [...drift].sort(bySeverityThen((d) => `${d.pageId} ${d.elementId}`)),
    affectedPageObjects: [...byClass.values()]
      .map((p) => ({ ...p, drift: sortDrift(p.drift), via: [...p.via].sort() }))
      .sort(bySeverityThen((p) => p.className)),
    affectedTests: [...testsByKey.values()]
      .map((t) => ({ ...t, through: [...t.through].sort() }))
      .sort(bySeverityThen((t) => `${t.file ?? ''} ${t.testId}`)),
    unmapped: sortDrift(unmapped),
    newElements: [...newElements].sort((a, b) =>
      `${a.pageId} ${a.elementId}`.localeCompare(`${b.pageId} ${b.elementId}`),
    ),
    removedPages: [...diff.removedPages].sort(),
  };
}

/** Fields whose change can move the emitted locator off the element. */
const IDENTITY_FIELDS = new Set(['role', 'name', 'testId', 'domId', 'tagName', 'framePath']);

/** Selector strategies whose candidate value survives into the emitted code. */
const MATCHABLE_STRATEGIES = new Set(['testid', 'label', 'placeholder', 'text', 'css']);

interface Owner {
  className: string;
  file?: string;
  selectorsUsed: string[];
  via: 'record' | 'selector';
}

function ownersOf(
  entry: ElementDrift,
  beforeElements: Map<string, { element: Element; pageId: string; url: string }>,
  index: SuiteIndex,
  records: StoredPageObject[],
): Owner[] {
  const fileOf = new Map(index.pageObjects.map((p) => [p.className, p.file]));
  const selectorsOf = new Map(index.pageObjects.map((p) => [p.className, p.selectorsUsed]));
  const owners: Owner[] = [];

  for (const record of records) {
    if (!record.elementIds.includes(entry.elementId)) continue;
    const file = fileOf.get(record.className);
    owners.push({
      className: record.className,
      ...(file !== undefined ? { file } : {}),
      selectorsUsed: selectorsOf.get(record.className) ?? [],
      via: 'record',
    });
  }

  // Selector link: what the suite literally writes down. Only strategies whose
  // candidate value reaches the emitted call as its first argument — see the
  // module comment on why `role` is excluded.
  const known = beforeElements.get(entry.elementId);
  const values = new Set(
    (known?.element.selectorCandidates ?? [])
      .filter((c) => MATCHABLE_STRATEGIES.has(c.strategy))
      .map((c) => c.value),
  );
  if (values.size > 0) {
    for (const pageObject of index.pageObjects) {
      if (owners.some((o) => o.className === pageObject.className)) continue;
      if (!pageObject.selectorsUsed.some((s) => values.has(s))) continue;
      owners.push({
        className: pageObject.className,
        file: pageObject.file,
        selectorsUsed: pageObject.selectorsUsed,
        via: 'selector',
      });
    }
  }

  return owners;
}

/**
 * A lost selector is only certain breakage when the page object uses that exact
 * string. When it does not, the page object addresses the element some other
 * way and might survive — `likely`, not `breaks`. Overstating this is how a
 * drift report gets ignored.
 */
function severityFor(entry: ElementDrift, selectorsUsed: string[]): DriftSeverity {
  if (entry.kind === 'removed') return 'breaks';
  if (entry.kind === 'selector-gone') {
    const used = new Set(selectorsUsed);
    return entry.lostSelectors.some((s) => used.has(s)) ? 'breaks' : 'likely';
  }
  return entry.severity;
}

/** `-selector [testid] [data-test="x"]` -> `[data-test="x"]`. */
function stripSelectorPrefix(change: string): string {
  const match = /^-selector \[[^\]]+\] (.*)$/.exec(change);
  return match?.[1] ?? change.slice('-selector '.length);
}

function describeElement(element: Element | undefined): string {
  if (element === undefined) return 'element removed';
  const name = element.name === undefined ? '' : ` "${element.name}"`;
  return `${element.role ?? element.tagName}${name} removed`;
}

function selectorValues(element: Element): string[] {
  return element.selectorCandidates.map((c) => c.value).sort();
}

function specLookup(index: SuiteIndex): (testId: string) => string | undefined {
  const byTitle = new Map<string, string>();
  for (const spec of index.specs) {
    for (const title of spec.testTitles) {
      // A title in two files is ambiguous; first in the index's stable order
      // wins, so the answer does not depend on scan order.
      if (!byTitle.has(title)) byTitle.set(title, spec.file);
    }
  }
  return (testId) => byTitle.get(testId);
}

function worse(a: DriftSeverity, b: DriftSeverity): DriftSeverity {
  return SEVERITY_ORDER[a] >= SEVERITY_ORDER[b] ? a : b;
}

function sortDrift(entries: ElementDrift[]): ElementDrift[] {
  return [...entries].sort(bySeverityThen((d) => `${d.pageId} ${d.elementId}`));
}

function bySeverityThen<T extends { severity: DriftSeverity }>(
  key: (item: T) => string,
): (a: T, b: T) => number {
  return (a, b) => {
    const bySeverity = SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity];
    return bySeverity !== 0 ? bySeverity : key(a).localeCompare(key(b));
  };
}

/** Tests that will not merely wobble — the headline number. */
export function breakingTests(impact: DriftImpact): AffectedTest[] {
  return impact.affectedTests.filter((t) => t.severity === 'breaks');
}

const MARK: Record<DriftSeverity, string> = { breaks: '✗', likely: '~', possible: '·' };

/** Human report for the CLI. Leads with the answer, not the evidence. */
export function formatImpact(impact: DriftImpact): string {
  const lines: string[] = [];
  const tests = impact.affectedTests;

  if (tests.length === 0 && impact.affectedPageObjects.length === 0) {
    lines.push('Drift impact: no test in the suite addresses anything that changed.');
    if (impact.unmapped.length > 0) {
      lines.push(`  ${impact.unmapped.length} change(s) touch parts of the app nothing tests yet.`);
    }
    if (impact.newElements.length > 0) {
      lines.push(`  ${impact.newElements.length} new element(s) — coverage worth adding.`);
    }
    return lines.join('\n');
  }

  const breaking = breakingTests(impact).length;
  lines.push(
    breaking > 0
      ? `Drift impact: ${breaking} test(s) will break, ${tests.length - breaking} more at risk.`
      : `Drift impact: ${tests.length} test(s) at risk; none certain to break.`,
  );

  if (impact.affectedPageObjects.length > 0) {
    lines.push('');
    lines.push('Page objects:');
    for (const pageObject of impact.affectedPageObjects) {
      const where = pageObject.file === undefined ? '' : `  ${pageObject.file}`;
      lines.push(`  ${MARK[pageObject.severity]} ${pageObject.className}${where}`);
      for (const entry of pageObject.drift.slice(0, 5)) {
        lines.push(`      ${entry.elementId}  ${entry.detail}`);
      }
      if (pageObject.drift.length > 5) {
        lines.push(`      … and ${pageObject.drift.length - 5} more element(s)`);
      }
    }
  }

  if (tests.length > 0) {
    lines.push('');
    lines.push('Tests:');
    for (const test of tests) {
      const where = test.file === undefined ? '(file unknown)' : test.file;
      lines.push(`  ${MARK[test.severity]} ${test.testId}`);
      lines.push(`      ${where}  [@feature:${test.featureId}]`);
    }
  }

  if (impact.unmapped.length > 0) {
    lines.push('');
    lines.push(`${impact.unmapped.length} other change(s) affect nothing the suite addresses.`);
  }
  if (impact.newElements.length > 0) {
    lines.push(`${impact.newElements.length} new element(s) — coverage worth adding.`);
  }

  return lines.join('\n');
}
