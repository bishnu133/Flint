import type { Frame, Locator, Page as PwPage } from '@playwright/test';
import type {
  Element,
  ElementProvenance,
  Page,
  ReachedVia,
  SelectorCandidate,
} from '../schemas/screen-model.js';
import { buildCandidates, applyVerification, type ElementFacts } from './selector-ranker.js';
import { normalizePath, type NormalizeRule } from './url-policy.js';
import { sha256 } from '../shared/hashing.js';
import { silentLogger, type Logger } from '../shared/logger.js';

/**
 * Per-page element extraction.
 *
 * Everything goes through Playwright **locator** APIs rather than raw DOM
 * walks, which is what makes open shadow roots work for free (locators pierce
 * them; `document.querySelectorAll` does not).
 *
 * Uniqueness is verified live here — a candidate is only trusted after
 * `locator.count() === 1` on the real page. That is the mechanism behind core
 * principle #1: the generator can never emit a selector nobody confirmed.
 */

/** Elements a test could plausibly interact with or assert on. */
const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[contenteditable="true"]',
  '[data-testid]',
].join(', ');

export interface ExtractOptions {
  /** Attribute holding test ids. Defaults to `data-testid`. */
  testIdAttribute?: string;
  /** Demote text-derived selector strategies (i18n apps). */
  i18n?: boolean;
  /** urlPattern normalization rules from config. */
  normalizeRules?: NormalizeRule[];
  /** Cap on elements captured per page, to bound pathological pages. */
  maxElements?: number;
  /** How the crawler arrived here. */
  reachedVia?: ReachedVia;
  /** Role this page was captured under, for multi-role exploration. */
  role?: string;
  /** Where to write the screenshot; omitted = no screenshot. */
  screenshotPath?: string;
  /**
   * What to record in the model, when that should differ from where the file
   * is written. The crawler stores a path relative to the model file so a
   * committed Screen Model is not tied to one machine's directory layout.
   */
  screenshotRef?: string;
  /** Stamped onto every element on the page. Flows pass their flowId + step. */
  provenance?: ElementProvenance;
  logger?: Logger;
}

const DEFAULT_MAX_ELEMENTS = 300;
/** Gap between the two uniqueness readings. Long enough to catch a re-render. */
const CONFIRM_DELAY_MS = 120;

/** Extract a complete Screen Model page from a live Playwright page. */
export async function extractPage(page: PwPage, options: ExtractOptions = {}): Promise<Page> {
  const testIdAttribute = options.testIdAttribute ?? 'data-testid';
  const rankOptions = { i18n: options.i18n === true, testIdAttribute };
  const url = page.url();
  const urlPattern = normalizePath(url, options.normalizeRules ?? []);

  const title = await page.title().catch(() => '');
  const lang = await page
    .locator('html')
    .getAttribute('lang')
    .catch(() => null);

  const elements: Element[] = [];
  const seenIds = new Set<string>();

  // Main frame first, then same-origin child frames. Cross-origin frames are
  // unreachable — the browser gives us an opaque handle — so they are skipped,
  // and logged, because a page whose main content lives in a cross-origin
  // iframe would otherwise index as "no elements" with no explanation.
  const logger = options.logger ?? silentLogger();
  const { frames, crossOrigin } = childFrames(page);
  for (const skipped of crossOrigin) {
    logger.warn(
      { page: url, frame: skipped },
      'cross-origin iframe skipped — its elements cannot be modelled',
    );
  }

  for (const { frame, framePath } of frames) {
    const remaining = (options.maxElements ?? DEFAULT_MAX_ELEMENTS) - elements.length;
    if (remaining <= 0) break;
    const frameElements = await extractFrame(frame, {
      framePath,
      testIdAttribute,
      rankOptions,
      limit: remaining,
      seenIds,
      ...(options.provenance !== undefined ? { provenance: options.provenance } : {}),
    });
    elements.push(...frameElements);
  }

  if (options.screenshotPath !== undefined) {
    await page.screenshot({ path: options.screenshotPath, fullPage: false }).catch(() => undefined); // a screenshot failure must never fail the crawl
  }

  const navTargets = await collectNavTargets(page);

  return {
    id: pageId(urlPattern, options.role),
    url,
    urlPattern,
    title,
    reachedVia: options.reachedVia ?? { kind: 'link', href: url },
    elements,
    navTargets,
    capturedAt: new Date().toISOString(),
    ...(lang !== null && lang !== '' ? { lang } : {}),
    ...(options.role !== undefined ? { role: options.role } : {}),
    ...(options.screenshotPath !== undefined
      ? { screenshotPath: options.screenshotRef ?? options.screenshotPath }
      : {}),
  };
}

/** Child frames split into reachable (same-origin, flattened one level) and not. */
function childFrames(page: PwPage): {
  frames: Array<{ frame: Frame; framePath: string[] }>;
  crossOrigin: string[];
} {
  const frames: Array<{ frame: Frame; framePath: string[] }> = [
    { frame: page.mainFrame(), framePath: [] },
  ];
  const crossOrigin: string[] = [];
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    try {
      if (new URL(frame.url()).origin !== new URL(page.url()).origin) {
        crossOrigin.push(frame.name() || frame.url());
        continue;
      }
    } catch {
      crossOrigin.push(frame.name() || frame.url());
      continue;
    }
    frames.push({ frame, framePath: [frame.name() || frame.url()] });
  }
  return { frames, crossOrigin };
}

interface FrameExtractOptions {
  framePath: string[];
  testIdAttribute: string;
  rankOptions: { i18n: boolean; testIdAttribute: string };
  limit: number;
  seenIds: Set<string>;
  provenance?: ElementProvenance;
}

export interface FrameElementsOptions {
  testIdAttribute?: string;
  i18n?: boolean;
  framePath?: string[];
  maxElements?: number;
  /** Element ids already captured; passing one across calls suppresses repeats. */
  seenIds?: Set<string>;
  /**
   * Stamped onto every element extracted in this call. The interaction pass
   * passes `{kind:'revealed', openerElementId}` so the Emitter knows to click
   * the opener first; page-load extraction leaves it unset.
   */
  provenance?: ElementProvenance;
}

/**
 * Extract the interactive elements of a single frame.
 *
 * Exposed for the bounded interaction pass, which re-reads a frame after
 * opening a menu or modal and diffs the result against the first pass.
 */
export async function extractFrameElements(
  frame: Frame,
  options: FrameElementsOptions = {},
): Promise<Element[]> {
  const testIdAttribute = options.testIdAttribute ?? 'data-testid';
  return extractFrame(frame, {
    framePath: options.framePath ?? [],
    testIdAttribute,
    rankOptions: { i18n: options.i18n === true, testIdAttribute },
    limit: options.maxElements ?? DEFAULT_MAX_ELEMENTS,
    seenIds: options.seenIds ?? new Set<string>(),
    ...(options.provenance !== undefined ? { provenance: options.provenance } : {}),
  });
}

async function extractFrame(frame: Frame, opts: FrameExtractOptions): Promise<Element[]> {
  const handles = await frame
    .locator(INTERACTIVE_SELECTOR)
    .all()
    .catch(() => []);
  const elements: Element[] = [];

  for (const locator of handles.slice(0, opts.limit)) {
    const element = await extractElement(frame, locator, opts).catch(() => undefined);
    // A detached or unreadable node is skipped rather than failing the page.
    if (element === undefined) continue;
    if (opts.seenIds.has(element.id)) continue;
    opts.seenIds.add(element.id);
    elements.push(element);
  }
  return elements;
}

async function extractElement(
  frame: Frame,
  locator: Locator,
  opts: FrameExtractOptions,
): Promise<Element | undefined> {
  const facts = await readFacts(locator, opts.testIdAttribute);
  if (facts === undefined) return undefined;

  const box = await locator.boundingBox().catch(() => null);
  const [visible, enabled] = await Promise.all([
    locator.isVisible().catch(() => false),
    locator.isEnabled().catch(() => false),
  ]);

  const candidates = buildCandidates(facts.elementFacts, opts.rankOptions);
  const verified = await verifyCandidates(frame, candidates, opts);

  return {
    id: elementId(facts, opts.framePath),
    role: facts.role ?? facts.tagName,
    name: facts.elementFacts.name ?? '',
    tagName: facts.tagName,
    boundingBox: box ?? { x: 0, y: 0, width: 0, height: 0 },
    states: { visible, enabled },
    selectorCandidates: verified,
    ...(facts.elementFacts.testId !== undefined ? { testId: facts.elementFacts.testId } : {}),
    ...(facts.domId !== undefined && facts.domId !== '' ? { domId: facts.domId } : {}),
    ...(facts.elementFacts.text !== undefined ? { text: facts.elementFacts.text } : {}),
    ...(opts.framePath.length > 0 ? { framePath: opts.framePath } : {}),
    ...(opts.provenance !== undefined ? { provenance: opts.provenance } : {}),
  };
}

interface ReadFacts {
  elementFacts: ElementFacts;
  role?: string;
  tagName: string;
  domId?: string;
}

/** Read every fact the ranker needs, in one evaluate to limit round-trips. */
async function readFacts(
  locator: Locator,
  testIdAttribute: string,
): Promise<ReadFacts | undefined> {
  const raw = await locator
    .evaluate((node: globalThis.Element, attr: string) => {
      const el = node as globalThis.HTMLElement;
      const labelText = (): string | undefined => {
        const id = el.getAttribute('id');
        if (id !== null && id !== '') {
          const forLabel = el.ownerDocument.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (forLabel?.textContent) return forLabel.textContent.trim();
        }
        const wrapping = el.closest('label');
        return wrapping?.textContent?.trim() ?? undefined;
      };
      // A short, scoped CSS path — the guaranteed last-resort candidate.
      const cssPath = (): string => {
        const parts: string[] = [];
        let cur: globalThis.Element | null = el;
        let depth = 0;
        while (cur !== null && cur.nodeType === 1 && depth < 4) {
          let part = cur.tagName.toLowerCase();
          if (cur.id !== '') {
            parts.unshift(`#${CSS.escape(cur.id)}`);
            break;
          }
          const parent: globalThis.Element | null = cur.parentElement;
          if (parent !== null) {
            const sameTag = [...parent.children].filter((c) => c.tagName === cur!.tagName);
            if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(cur) + 1})`;
          }
          parts.unshift(part);
          cur = parent;
          depth += 1;
        }
        return parts.join(' > ');
      };
      return {
        tagName: el.tagName.toLowerCase(),
        // `type` decides both the role and, for the button-shaped inputs, where
        // the accessible name comes from. Read the attribute rather than the
        // IDL property so an invalid value stays visible to the mapper.
        inputType: el.getAttribute('type')?.trim().toLowerCase() ?? undefined,
        value: el.getAttribute('value') ?? undefined,
        alt: el.getAttribute('alt') ?? undefined,
        testId: el.getAttribute(attr) ?? undefined,
        domId: el.getAttribute('id') ?? undefined,
        explicitRole: el.getAttribute('role') ?? undefined,
        ariaLabel: el.getAttribute('aria-label') ?? undefined,
        placeholder: el.getAttribute('placeholder') ?? undefined,
        label: labelText(),
        text: el.textContent?.trim().slice(0, 120) ?? undefined,
        css: cssPath(),
      };
    }, testIdAttribute)
    .catch(() => undefined);

  if (raw === undefined) return undefined;

  const role = raw.explicitRole ?? implicitRole(raw.tagName, raw.inputType);
  const name = accessibleName(raw);

  return {
    tagName: raw.tagName,
    role,
    domId: raw.domId,
    elementFacts: {
      testId: raw.testId,
      role,
      name,
      label: raw.label,
      placeholder: raw.placeholder,
      text: raw.text,
      css: raw.css,
    },
  };
}

/**
 * Facts about an input that change how its name is computed.
 * `<input type=submit value="Login">` is named by its value, not its text.
 */
interface NameFacts {
  tagName: string;
  inputType?: string;
  value?: string;
  alt?: string;
  ariaLabel?: string;
  label?: string;
  placeholder?: string;
  text?: string;
}

/** Input types whose accessible name comes from `value`, not from a label. */
const VALUE_NAMED_INPUTS: ReadonlySet<string> = new Set(['submit', 'reset', 'button']);

/** Browser-supplied default names for the two inputs that have one. */
const DEFAULT_INPUT_NAMES: Readonly<Record<string, string>> = { submit: 'Submit', reset: 'Reset' };

/**
 * Accessible name, following the parts of HTML-AAM that change which selector
 * we can emit.
 *
 * For most elements: aria-label > `<label>` > placeholder > visible text.
 * placeholder must be in that chain — for a bare `<input placeholder="X">` the
 * accessible name IS "X", so `getByRole('textbox', {name:'X'})` matches;
 * omitting it costs a role candidate (85) and leaves placeholder (65) on top.
 *
 * Button-shaped inputs are the exception: their name comes from `value` (an
 * `<input type=submit value="Login">` is `button "Login"`, and a `<label>` does
 * not name it), falling back to the browser default for submit/reset.
 */
function accessibleName(facts: NameFacts): string | undefined {
  const chain: Array<string | undefined> = [facts.ariaLabel];
  if (facts.tagName === 'input') {
    const type = facts.inputType ?? 'text';
    if (VALUE_NAMED_INPUTS.has(type)) {
      chain.push(facts.value, DEFAULT_INPUT_NAMES[type]);
    } else if (type === 'image') {
      chain.push(facts.alt, facts.value);
    }
  }
  chain.push(facts.label, facts.placeholder, facts.text);
  return chain.find((v) => v !== undefined && v.trim() !== '');
}

/**
 * Implicit ARIA role for the tags we enumerate.
 *
 * `input` is not one role. Mapping every input to `textbox` made a submit
 * button look like a third text field to the planner, and produced
 * `getByRole('textbox')` selectors that match nothing for checkboxes, radios
 * and password fields. Types with no role mapping (password, file, date,
 * colour…) return undefined on purpose: `getByRole('textbox')` genuinely does
 * not match a password input, so a role candidate there would be a selector
 * that never resolves.
 */
export function implicitRole(tagName: string, inputType?: string): string | undefined {
  switch (tagName) {
    case 'a':
      return 'link';
    case 'button':
      return 'button';
    case 'select':
      return 'combobox';
    case 'textarea':
      return 'textbox';
    case 'input':
      return implicitInputRole(inputType);
    default:
      return undefined;
  }
}

/** HTML-AAM `input` type -> role. Unlisted types have no role mapping. */
function implicitInputRole(inputType?: string): string | undefined {
  switch (inputType?.trim().toLowerCase() ?? 'text') {
    case 'submit':
    case 'reset':
    case 'button':
    case 'image':
      return 'button';
    case 'checkbox':
      return 'checkbox';
    case 'radio':
      return 'radio';
    case 'range':
      return 'slider';
    case 'number':
      return 'spinbutton';
    case 'search':
      return 'searchbox';
    // No role mapping exists for these — `getByRole('textbox')` does not match
    // a password or a date picker, so emitting a role candidate would produce a
    // selector that resolves to nothing.
    case 'password':
    case 'file':
    case 'color':
    case 'date':
    case 'datetime-local':
    case 'month':
    case 'week':
    case 'time':
    case 'hidden':
      return undefined;
    default:
      // text, email, tel, url — plus any invalid type, which the HTML spec
      // says renders in the Text state.
      return 'textbox';
  }
}

/**
 * Verify each candidate against the live frame and re-score it.
 *
 * This is the step that turns a guess into evidence. A candidate that resolves
 * to 0 or 2+ nodes is marked non-unique and penalised; only survivors are
 * eligible for the Emitter.
 */
async function verifyCandidates(
  frame: Frame,
  candidates: SelectorCandidate[],
  opts: FrameExtractOptions,
): Promise<SelectorCandidate[]> {
  // Two readings, not one. A single `count()` is a snapshot of a moving DOM:
  // a React re-render between the crawl and a later run flips `unique`, and
  // since `unique` is the only field verification can change, that shows up as
  // phantom drift in `explore --diff` on an app nobody touched.
  //
  // Disagreement resolves to *not* unique, which is the safe direction —
  // `pickBest` only offers verified-unique candidates to the Emitter, so an
  // unstable selector is excluded rather than turned into a flaky test.
  const first = await countAll(frame, candidates);
  await sleep(CONFIRM_DELAY_MS);
  const second = await countAll(frame, candidates);

  return candidates.map((candidate, i) =>
    applyVerification(candidate, first[i] === 1 && second[i] === 1, opts.rankOptions),
  );
}

/** Counts run in parallel — two confirmed passes cost less than one serial one. */
async function countAll(frame: Frame, candidates: SelectorCandidate[]): Promise<number[]> {
  return Promise.all(
    // -1 means the selector was not even resolvable; treated as non-unique.
    candidates.map((candidate) => countFor(frame, candidate).catch(() => -1)),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Translate a stored candidate into the matching Playwright locator. */
export function locatorFor(frame: Frame, candidate: SelectorCandidate): Locator {
  switch (candidate.strategy) {
    case 'testid':
    case 'css':
      return frame.locator(candidate.value);
    case 'role': {
      const match = /^(.+?)\[name="(.*)"\]$/s.exec(candidate.value);
      if (match === null) return frame.locator(candidate.value);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- why: Playwright's role union is not exported; the value came from a live ARIA role.
      return frame.getByRole(match[1] as any, { name: match[2]!, exact: true });
    }
    case 'label':
      return frame.getByLabel(candidate.value, { exact: true });
    case 'placeholder':
      return frame.getByPlaceholder(candidate.value, { exact: true });
    case 'text':
      return frame.getByText(candidate.value, { exact: true });
  }
}

async function countFor(frame: Frame, candidate: SelectorCandidate): Promise<number> {
  return locatorFor(frame, candidate).count();
}

/**
 * Stable element id, derived from identifying facts rather than DOM order.
 * Order-derived ids would make every re-crawl report the whole page as changed.
 */
export function elementId(facts: ReadFacts, framePath: string[]): string {
  const basis = [
    framePath.join('/'),
    facts.tagName,
    facts.role ?? '',
    facts.elementFacts.testId ?? '',
    facts.domId ?? '',
    facts.elementFacts.name ?? '',
    facts.elementFacts.css,
  ].join('|');
  return `el-${sha256(basis).slice(0, 12)}`;
}

/** Stable page id derived from the normalized pattern (+ role, if any). */
export function pageId(urlPattern: string, role?: string): string {
  const basis = role === undefined || role === '' ? urlPattern : `${role}|${urlPattern}`;
  return `page-${sha256(basis).slice(0, 12)}`;
}

/** Same-origin hrefs on the page — the crawler's frontier candidates. */
async function collectNavTargets(page: PwPage): Promise<string[]> {
  const hrefs = await page
    .locator('a[href]')
    .evaluateAll((nodes: globalThis.Element[]) =>
      nodes.map((n) => n.getAttribute('href') ?? '').filter((h) => h !== ''),
    )
    .catch(() => [] as string[]);
  return [...new Set(hrefs)].sort((a, b) => a.localeCompare(b));
}
