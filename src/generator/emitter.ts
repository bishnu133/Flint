import type { Element, Page, ScreenModel } from '../schemas/screen-model.js';
import type { PlanStep, TestCase, TestPlan } from '../schemas/test-plan.js';
import { pickBest } from '../explorer/selector-ranker.js';
import type { StoredPageObject } from './page-object-store.js';
import { silentLogger, type Logger } from '../shared/logger.js';
import {
  actionMethodName,
  camelCase,
  locatorName,
  pageClassName,
  pageObjectFileName,
  specFileName,
  uniquify,
} from './naming.js';
import type {
  Dialect,
  EmittedAction,
  EmittedLocator,
  EmittedMethod,
  EmittedSelector,
  EmittedStatement,
  EmittedTest,
  EmittedTestMode,
  PageObjectSpec,
} from './dialects/types.js';

/**
 * Stage B — TestPlan to TypeScript.
 *
 * Deliberately deterministic rather than model-driven. The TestPlan is already
 * a complete, validated instruction set: every step names an action, an element
 * id that exists, and a value. Turning that into code is a mechanical
 * transform, and doing it mechanically is what buys the three things Phase 4 is
 * judged on — byte-identical regeneration, a 100% compile rate, and selectors
 * that are exactly the ones exploration verified. A model in this position
 * could only add naming flair, at the cost of all three.
 *
 * (Recorded in PHASE_NOTES.md: the master plan's "temperature 0 for Stage B"
 * anticipated an LLM here. CLAUDE.md rule 7 says prefer the simpler
 * deterministic option and flag it, so that is what this does. The dialect seam
 * is where a model-driven emitter would slot in if one is ever wanted.)
 */

export interface EmitOptions {
  plan: TestPlan;
  model: ScreenModel;
  dialect: Dialect;
  /** `describe` title — the feature spec's human title. */
  title: string;
  /**
   * What the page objects already expose, from features generated earlier.
   *
   * Two features touching the same page share one page object, so emitting the
   * second must not drop what the first put there. Omitting this is only
   * correct on a first run — `flint generate` always passes the stored record.
   */
  existingPageObjects?: StoredPageObject[];
  logger?: Logger;
}

/** A file the emitter wants written, with its path relative to the suite dir. */
export interface EmittedFile {
  /** Posix path relative to the suite root, e.g. `pages/login.page.ts`. */
  path: string;
  contents: string;
  kind: 'page-object' | 'spec';
}

/** Why a case did not become a live test. */
export interface DegradedCase {
  caseId: string;
  title: string;
  mode: 'fixme' | 'skip';
  reason: string;
}

export interface EmitResult {
  files: EmittedFile[];
  /**
   * What each page object this run wrote now exposes. The caller merges this
   * into the stored record so the next feature builds on it.
   */
  pageObjectRecords: StoredPageObject[];
  /** Cases emitted as `test.fixme()` or `test.skip()`, and why. */
  degraded: DegradedCase[];
  /** Cases the plan marked `skipped-duplicate`; nothing was written for them. */
  skippedDuplicates: string[];
  /** Page-object class names this feature touched. */
  pageObjects: string[];
}

/** Marks a test that is complete but waiting on setup. See the TestPlan schema. */
export const NEEDS_SETUP_TAG = '@needs-setup';

/**
 * The locator property name for an element.
 *
 * When an element has no accessible name — a `<select>` whose options are not a
 * label, an icon-only button — the fallback is the best remaining human-readable
 * handle: its test id, then its dom id, then its content-derived element id. A
 * test id reads as `productSortContainerSelect`, which beats `el1a2b3c4dSelect`.
 */
function locatorFor(element: Element): string {
  return locatorName(element.role, element.name, element.testId ?? element.domId ?? element.id);
}

/**
 * Compare two URLs as the browser would.
 *
 * The crawler records what the browser reported (`https://app.example.com`,
 * no path); a plan's `goto` usually carries the canonical form
 * (`https://app.example.com/`). They are the same page, and an exact string
 * compare would emit a bare `page.goto(...)` instead of the page object's own
 * `goto()` — defeating the point of the page object owning its URL.
 */
function canonicalUrl(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url; // not absolute; compare as given
  }
}

/** An element resolved out of the Screen Model, with the page it lives on. */
interface ResolvedElement {
  element: Element;
  page: Page;
  /** The selector the Emitter may use, or undefined when none was verified. */
  selector?: EmittedSelector;
}

export function emitFeature(options: EmitOptions): EmitResult {
  const logger = options.logger ?? silentLogger();
  const { plan, model, dialect } = options;

  const byElementId = indexElements(model);

  // Only cases that produce code contribute page objects. A skipped duplicate
  // is a reviewable record in the plan, not a file.
  const emittable = plan.cases.filter((c) => c.status !== 'skipped-duplicate');
  const skippedDuplicates = plan.cases
    .filter((c) => c.status === 'skipped-duplicate')
    .map((c) => c.id);

  const usage = collectUsage(emittable, byElementId);
  seedFromRecords(usage, options.existingPageObjects ?? [], byElementId, plan.featureId, logger);
  const pageObjects = buildPageObjects(usage, dialect);

  const degraded: DegradedCase[] = [];
  const tests = emittable.map((testCase) =>
    buildTest(testCase, byElementId, pageObjects, degraded),
  );

  const files: EmittedFile[] = [];
  for (const pageObject of pageObjects.values()) {
    files.push({
      path: `${dialect.pageObjectDir}/${pageObjectFileName(pageObject.spec.className)}`,
      contents: dialect.emitPageObject(pageObject.spec),
      kind: 'page-object',
    });
  }
  files.push({
    path: `${dialect.specDir}/${specFileName(plan.featureId)}`,
    contents: dialect.emitSpec({ featureId: plan.featureId, title: options.title, tests }),
    kind: 'spec',
  });

  files.sort((a, b) => a.path.localeCompare(b.path));

  logger.info(
    {
      feature: plan.featureId,
      files: files.length,
      pageObjects: pageObjects.size,
      degraded: degraded.length,
    },
    'emit: generated',
  );

  return {
    files,
    pageObjectRecords: recordsFor(usage, pageObjects, plan.featureId),
    degraded,
    skippedDuplicates,
    pageObjects: [...pageObjects.values()].map((p) => p.spec.className).sort(),
  };
}

/**
 * Fold what earlier features put on a page back into this run's usage.
 *
 * An element id that is no longer in the Screen Model, or that lost its
 * verified-unique selector, is dropped and logged rather than carried: a page
 * object must not outlive the UI it addresses. The spec that used it will fail
 * to compile, which is the correct, loud outcome — and exactly what the compile
 * gate is there to catch before anything is written.
 */
function seedFromRecords(
  usage: Map<string, PageUsage>,
  records: StoredPageObject[],
  byElementId: Map<string, ResolvedElement>,
  featureId: string,
  logger: Logger,
): void {
  for (const record of records) {
    // Only pages this run is regenerating; a page nobody touched keeps its file.
    const entry = usage.get(record.pageId);
    if (entry === undefined) continue;

    const dropped: string[] = [];
    for (const elementId of record.elementIds) {
      const resolved = byElementId.get(elementId);
      if (resolved === undefined || resolved.selector === undefined) {
        dropped.push(elementId);
        continue;
      }
      entry.elements.set(elementId, resolved.element);
    }
    for (const action of record.actions) {
      if (!entry.elements.has(action.elementId)) continue;
      entry.actions.set(`${action.kind}:${action.elementId}`, {
        kind: action.kind,
        elementId: action.elementId,
      });
    }

    if (dropped.length > 0) {
      logger.warn(
        { feature: featureId, pageObject: record.className, elements: dropped.sort() },
        'emit: dropping locators whose elements are gone from the Screen Model — specs using them will stop compiling',
      );
    }
  }
}

/** What each page object this run wrote now exposes. */
function recordsFor(
  usage: Map<string, PageUsage>,
  pageObjects: Map<string, BuiltPageObject>,
  featureId: string,
): StoredPageObject[] {
  const records: StoredPageObject[] = [];
  for (const [pageId, entry] of usage) {
    const built = pageObjects.get(pageId);
    if (built === undefined) continue;
    records.push({
      className: built.spec.className,
      pageId,
      features: [featureId],
      elementIds: [...entry.elements.keys()].sort((a, b) => a.localeCompare(b)),
      actions: [...entry.actions.values()]
        .map((action) => ({ kind: action.kind, elementId: action.elementId }))
        .sort((a, b) => `${a.kind}:${a.elementId}`.localeCompare(`${b.kind}:${b.elementId}`)),
    });
  }
  return records.sort((a, b) => a.pageId.localeCompare(b.pageId));
}

/** Element id -> the element and the page it was captured on. */
function indexElements(model: ScreenModel): Map<string, ResolvedElement> {
  const index = new Map<string, ResolvedElement>();
  for (const page of model.pages) {
    for (const element of page.elements) {
      if (index.has(element.id)) continue; // first page wins; pages are stably ordered
      index.set(element.id, { element, page, ...selectorFor(element) });
    }
  }
  return index;
}

/**
 * The one selector the Emitter is allowed to use.
 *
 * `pickBest` returns the highest-scored candidate that is both verified and
 * unique, or nothing. Nothing is not a reason to guess — it is the reason a
 * case becomes `test.fixme()`.
 */
function selectorFor(element: Element): { selector?: EmittedSelector } {
  const best = pickBest(element.selectorCandidates);
  if (best === undefined) return {};
  return {
    selector: {
      strategy: best.strategy,
      value: best.value,
      score: best.score,
      elementId: element.id,
      description: describeElement(element),
      ...(element.framePath !== undefined ? { framePath: element.framePath } : {}),
    },
  };
}

function describeElement(element: Element): string {
  return element.name === '' ? element.role : `${element.role} "${element.name}"`;
}

/** Which elements each page needs a locator for, and which actions they take. */
interface PageUsage {
  page: Page;
  elements: Map<string, Element>;
  /** `${action}:${elementId}` -> the action kind, deduped. */
  actions: Map<string, { kind: EmittedAction['kind']; elementId: string }>;
}

function collectUsage(
  cases: TestCase[],
  byElementId: Map<string, ResolvedElement>,
): Map<string, PageUsage> {
  const usage = new Map<string, PageUsage>();

  for (const testCase of cases) {
    for (const step of testCase.steps) {
      if (step.elementRef === undefined) continue;
      const resolved = byElementId.get(step.elementRef);
      // An unknown ref cannot happen — Phase 3 refuses such a plan — but the
      // Emitter must not crash if a stored plan predates a re-explore.
      if (resolved === undefined || resolved.selector === undefined) continue;

      const entry = usage.get(resolved.page.id) ?? {
        page: resolved.page,
        elements: new Map<string, Element>(),
        actions: new Map<string, { kind: EmittedAction['kind']; elementId: string }>(),
      };
      entry.elements.set(resolved.element.id, resolved.element);

      const actionKind = methodActionFor(step);
      if (actionKind !== undefined) {
        entry.actions.set(`${actionKind}:${resolved.element.id}`, {
          kind: actionKind,
          elementId: resolved.element.id,
        });
      }
      usage.set(resolved.page.id, entry);
    }
  }
  return usage;
}

/** Which plan actions become page-object methods. Assertions stay in the spec. */
function methodActionFor(step: PlanStep): EmittedAction['kind'] | undefined {
  switch (step.action) {
    case 'click':
      return 'click';
    case 'fill':
      return 'fill';
    case 'select':
      return 'select';
    default:
      return undefined;
  }
}

interface BuiltPageObject {
  spec: PageObjectSpec;
  /** Element id -> locator property name. */
  locatorNames: Map<string, string>;
  /** `${action}:${elementId}` -> method name. */
  methodNames: Map<string, string>;
  variable: string;
  importPath: string;
}

function buildPageObjects(
  usage: Map<string, PageUsage>,
  dialect: Dialect,
): Map<string, BuiltPageObject> {
  const built = new Map<string, BuiltPageObject>();

  // Stable order: by page id, so two runs agree and so class-name collisions
  // between two pages resolve the same way every time.
  const pages = [...usage.values()].sort((a, b) => a.page.id.localeCompare(b.page.id));
  const classNames = uniquify(pages.map((u) => pageClassName(u.page.urlPattern, u.page.role)));

  pages.forEach((entry, pageIndex) => {
    const className = classNames[pageIndex]!;
    // Sorted by the name the property will get, so the class reads
    // alphabetically rather than in element-id-hash order. The element id is
    // the tiebreak, which keeps the ordering total and therefore stable.
    const elements = [...entry.elements.values()].sort((a, b) => {
      const byName = locatorFor(a).localeCompare(locatorFor(b));
      return byName !== 0 ? byName : a.id.localeCompare(b.id);
    });
    const names = uniquify(elements.map(locatorFor));

    const locatorNames = new Map<string, string>();
    const locators: EmittedLocator[] = [];
    elements.forEach((element, i) => {
      const name = names[i]!;
      locatorNames.set(element.id, name);
      const { selector } = selectorFor(element);
      if (selector === undefined) return; // filtered upstream; belt and braces
      locators.push({ name, selector });
    });

    const actions = [...entry.actions.entries()].sort(([a], [b]) => a.localeCompare(b));
    const methodNames = new Map<string, string>();
    const methodNameList = uniquify(
      actions.map(([, action]) =>
        actionMethodName(action.kind, locatorNames.get(action.elementId) ?? 'element'),
      ),
    );
    const methods: EmittedMethod[] = actions.map(([key, action], i) => {
      const methodName = methodNameList[i]!;
      methodNames.set(key, methodName);
      const locator = locatorNames.get(action.elementId) ?? 'element';
      const takesValue = action.kind !== 'click';
      return {
        name: methodName,
        parameters: takesValue ? ['value'] : [],
        actions: [{ kind: action.kind, locator, ...(takesValue ? { parameter: 'value' } : {}) }],
        summary: `${action.kind === 'click' ? 'Click' : verbFor(action.kind)} ${locator}.`,
      };
    });

    built.set(entry.page.id, {
      spec: {
        className,
        pageId: entry.page.id,
        url: canonicalUrl(entry.page.url),
        urlPattern: entry.page.urlPattern,
        locators,
        methods,
      },
      locatorNames,
      methodNames,
      variable: camelCase(className),
      importPath: `../${dialect.pageObjectDir}/${pageObjectFileName(className).replace(/\.ts$/, '')}`,
    });
  });

  return built;
}

function verbFor(kind: EmittedAction['kind']): string {
  return kind === 'fill' ? 'Fill' : 'Choose an option in';
}

function buildTest(
  testCase: TestCase,
  byElementId: Map<string, ResolvedElement>,
  pageObjects: Map<string, BuiltPageObject>,
  degraded: DegradedCase[],
): EmittedTest {
  const mode = decideMode(testCase, byElementId);
  if (mode.kind !== 'live') {
    degraded.push({
      caseId: testCase.id,
      title: testCase.title,
      mode: mode.kind,
      reason: mode.reason,
    });
  }

  const used = new Map<string, BuiltPageObject>();
  const statements: EmittedStatement[] = [];

  // A `goto` whose URL is one of this feature's page objects reads better as
  // that object's own `goto()` — the URL then lives in exactly one place.
  const byUrl = new Map<string, BuiltPageObject>();
  for (const pageObject of pageObjects.values()) byUrl.set(pageObject.spec.url, pageObject);

  for (const step of testCase.steps) {
    const resolved = step.elementRef === undefined ? undefined : byElementId.get(step.elementRef);
    let pageObject = resolved === undefined ? undefined : pageObjects.get(resolved.page.id);
    if (step.action === 'goto' && step.value !== undefined) {
      pageObject = byUrl.get(canonicalUrl(step.value));
    }
    if (pageObject !== undefined) used.set(pageObject.spec.className, pageObject);

    const statement = buildStatement(step, resolved, pageObject);
    if (statement !== undefined) statements.push(statement);
  }

  const notes: string[] = [];
  for (const prerequisite of testCase.prerequisites ?? []) {
    notes.push(`needs ${prerequisite.kind}: ${prerequisite.description}`);
  }
  for (const ref of testCase.acceptanceRefs ?? []) notes.push(`covers ${ref}`);
  if (testCase.status === 'update-existing' && testCase.duplicateOf !== undefined) {
    notes.push(`updates existing test: ${testCase.duplicateOf}`);
  }

  return {
    caseId: testCase.id,
    title: testCase.title,
    // `@needs-setup` is required by the TestPlan schema's emitter rule, and it
    // is the only thing that makes a skipped test findable: `--grep-invert
    // @needs-setup` is how a CI run excludes tests waiting on fixtures.
    tags: mode.kind === 'skip' ? [...testCase.tags, NEEDS_SETUP_TAG] : testCase.tags,
    mode,
    pageObjects: [...used.values()]
      .sort((a, b) => a.spec.className.localeCompare(b.spec.className))
      .map((p) => ({
        variable: p.variable,
        className: p.spec.className,
        importPath: p.importPath,
      })),
    statements,
    notes,
  };
}

/**
 * The LOCKED precedence from the TestPlan schema: blocked beats missing
 * selector beats prerequisites beats live.
 */
function decideMode(
  testCase: TestCase,
  byElementId: Map<string, ResolvedElement>,
): EmittedTestMode {
  if (testCase.status === 'blocked') {
    return { kind: 'fixme', reason: testCase.blockedReason ?? 'blocked by the planner' };
  }

  // Core principle #1: nothing gets emitted that nobody verified. Two very
  // different causes hide behind that, and they need different fixes, so they
  // are reported separately rather than as one vague "cannot select" message.
  const refs = testCase.steps
    .map((step) => step.elementRef)
    .filter((ref): ref is string => ref !== undefined);

  // The element is not in the Screen Model at all: the plan predates the
  // current crawl. Re-planning is the fix; adding a test id would not help.
  const missing = [...new Set(refs.filter((ref) => !byElementId.has(ref)))].sort();
  if (missing.length > 0) {
    return {
      kind: 'fixme',
      reason: `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not in the current Screen Model — this plan was made against an older crawl. Re-run \`flint plan\` for this feature.`,
    };
  }

  // The element exists but no candidate survived live verification — usually a
  // selector that matches more than one node. A test id fixes that.
  const unverified = [
    ...new Set(refs.filter((ref) => byElementId.get(ref)?.selector === undefined)),
  ].sort();
  if (unverified.length > 0) {
    return {
      kind: 'fixme',
      reason: `no verified-unique selector for ${unverified.join(', ')} — every candidate matched zero or several nodes. Add a data-testid, or re-run \`flint explore\`.`,
    };
  }

  const inFrame = testCase.steps
    .map((step) => step.elementRef)
    .filter((ref): ref is string => ref !== undefined)
    .filter((ref) => (byElementId.get(ref)?.element.framePath?.length ?? 0) > 0);
  if (inFrame.length > 0) {
    // The extractor verified uniqueness *inside* the frame; the selector that
    // addresses the frame itself was never verified, so emitting one would
    // break the guarantee. See PHASE_NOTES.md.
    const unique = [...new Set(inFrame)].sort();
    return {
      kind: 'fixme',
      reason: `${unique.join(', ')} lives inside an iframe, which the emitter cannot address yet`,
    };
  }

  const prerequisites = testCase.prerequisites ?? [];
  if (prerequisites.length > 0) {
    return {
      kind: 'skip',
      reason: `needs setup: ${prerequisites.map((p) => p.description).join('; ')}`,
    };
  }

  return { kind: 'live' };
}

function buildStatement(
  step: PlanStep,
  resolved: ResolvedElement | undefined,
  pageObject: BuiltPageObject | undefined,
): EmittedStatement | undefined {
  if (step.action === 'goto') {
    const url = step.value ?? '';
    return pageObject !== undefined && pageObject.spec.url === canonicalUrl(url)
      ? { kind: 'goto', pageVariable: pageObject.variable, url }
      : { kind: 'goto', url };
  }

  if (step.action === 'custom') {
    return { kind: 'comment', text: step.note ?? step.value ?? 'custom step' };
  }

  if (step.action === 'assert') {
    const assertion = step.assertion;
    if (assertion === undefined) return undefined;
    const target =
      resolved !== undefined && pageObject !== undefined
        ? {
            pageVariable: pageObject.variable,
            locator: pageObject.locatorNames.get(resolved.element.id) ?? 'unknown',
          }
        : undefined;
    return {
      kind: 'assert',
      assertion: {
        kind: assertion.kind,
        expected: assertion.expected,
        ...(target !== undefined && assertion.kind !== 'url' ? { target } : {}),
      },
    };
  }

  if (resolved === undefined || pageObject === undefined) return undefined;
  const actionKind = methodActionFor(step);
  if (actionKind === undefined) return undefined;

  const method = pageObject.methodNames.get(`${actionKind}:${resolved.element.id}`);
  if (method === undefined) return undefined;

  return {
    kind: 'call',
    pageVariable: pageObject.variable,
    method,
    args: step.value === undefined ? [] : [step.value],
  };
}
