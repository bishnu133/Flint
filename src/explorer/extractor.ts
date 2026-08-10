import type { Frame, Locator, Page as PwPage } from '@playwright/test';
import type { Element, Page, ReachedVia, SelectorCandidate } from '../schemas/screen-model.js';
import { buildCandidates, applyVerification, type ElementFacts } from './selector-ranker.js';
import { normalizePath, type NormalizeRule } from './url-policy.js';
import { sha256 } from '../shared/hashing.js';

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
}

const DEFAULT_MAX_ELEMENTS = 300;

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

  // Main frame first, then same-origin child frames (cross-origin are skipped
  // by the caller and logged — we cannot reach into them).
  const frames: Array<{ frame: Frame; framePath: string[] }> = [
    { frame: page.mainFrame(), framePath: [] },
    ...sameOriginChildFrames(page),
  ];

  for (const { frame, framePath } of frames) {
    const remaining = (options.maxElements ?? DEFAULT_MAX_ELEMENTS) - elements.length;
    if (remaining <= 0) break;
    const frameElements = await extractFrame(frame, {
      framePath,
      testIdAttribute,
      rankOptions,
      limit: remaining,
      seenIds,
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

/** Same-origin child frames, flattened one level with their path recorded. */
function sameOriginChildFrames(page: PwPage): Array<{ frame: Frame; framePath: string[] }> {
  const out: Array<{ frame: Frame; framePath: string[] }> = [];
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    // A cross-origin frame yields an opaque url we cannot query; skip it.
    try {
      if (new URL(frame.url()).origin !== new URL(page.url()).origin) continue;
    } catch {
      continue;
    }
    out.push({ frame, framePath: [frame.name() || frame.url()] });
  }
  return out;
}

interface FrameExtractOptions {
  framePath: string[];
  testIdAttribute: string;
  rankOptions: { i18n: boolean; testIdAttribute: string };
  limit: number;
  seenIds: Set<string>;
}

export interface FrameElementsOptions {
  testIdAttribute?: string;
  i18n?: boolean;
  framePath?: string[];
  maxElements?: number;
  /** Element ids already captured; passing one across calls suppresses repeats. */
  seenIds?: Set<string>;
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

  const role = raw.explicitRole ?? implicitRole(raw.tagName);
  // Accessible name: aria-label wins, then the label, then visible text.
  // ARIA accessible-name precedence: aria-label > <label> > placeholder > text.
  // placeholder must be in this chain — for a bare `<input placeholder="X">`
  // the accessible name IS "X", so `getByRole('textbox', {name:'X'})` matches.
  // Omitting it costs a role candidate (85) and leaves placeholder (65) on top.
  const name = raw.ariaLabel ?? raw.label ?? raw.placeholder ?? raw.text;

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

/** Minimal implicit-role mapping for the tags we enumerate. */
export function implicitRole(tagName: string): string | undefined {
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
      return 'textbox';
    default:
      return undefined;
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
  const out: SelectorCandidate[] = [];
  for (const candidate of candidates) {
    const count = await countFor(frame, candidate).catch(() => -1);
    // -1 means the selector was not even resolvable; treat as non-unique.
    out.push(applyVerification(candidate, count === 1, opts.rankOptions));
  }
  return out;
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
