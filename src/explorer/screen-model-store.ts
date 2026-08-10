import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ScreenModelSchema,
  type Element,
  type Page,
  type ScreenModel,
} from '../schemas/screen-model.js';
import { ConfigError } from '../shared/errors.js';
import { formatZodError } from '../shared/zod-format.js';
import { stableStringify } from '../shared/hashing.js';

/**
 * Screen Model persistence and diffing.
 *
 * Writes are deterministic: pages, elements, and selector candidates are all
 * sorted before serialization, so re-exploring an unchanged app produces a
 * byte-identical file and `git diff` shows only real drift.
 *
 * Pure apart from the fs calls — the differ takes two models as arguments and
 * is fully testable without a browser or a disk.
 */

/** Default location of the current model, relative to the project root. */
export const SCREEN_MODEL_DIR = join('.flint', 'screen-model');
export const CURRENT_MODEL_FILE = 'model.json';

/** Path to the current model, optionally scoped to a role. */
export function modelPath(projectRoot: string, role?: string): string {
  const name = role === undefined || role === '' ? CURRENT_MODEL_FILE : `model.${role}.json`;
  return join(projectRoot, SCREEN_MODEL_DIR, name);
}

/**
 * Sort a model into canonical order. Pages by id, elements by id, candidates by
 * score descending then strategy then value. Determinism is a project
 * requirement, not a nicety — Phase 4 must regenerate byte-identical output.
 */
export function canonicalize(model: ScreenModel): ScreenModel {
  return {
    ...model,
    pages: [...model.pages]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((page) => ({
        ...page,
        navTargets: [...page.navTargets].sort((a, b) => a.localeCompare(b)),
        elements: [...page.elements]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((el) => ({
            ...el,
            selectorCandidates: [...el.selectorCandidates].sort((a, b) => {
              if (b.score !== a.score) return b.score - a.score;
              if (a.strategy !== b.strategy) return a.strategy.localeCompare(b.strategy);
              return a.value.localeCompare(b.value);
            }),
          })),
      })),
  };
}

/** Write a model to disk in canonical form. Creates parent dirs as needed. */
export function writeModel(path: string, model: ScreenModel): void {
  mkdirSync(dirname(path), { recursive: true });
  const canonical = canonicalize(model);
  writeFileSync(path, `${JSON.stringify(canonical, null, 2)}\n`, 'utf8');
}

/** Read and validate a model. Throws a friendly error naming the bad key. */
export function readModel(path: string): ScreenModel {
  if (!existsSync(path)) {
    throw new ConfigError(`No Screen Model at ${path}.`, {
      hint: 'Run `flint explore` first to build one.',
    });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ConfigError(`Screen Model is not valid JSON: ${path}.`, {
      cause: err,
      hint: 'Delete it and re-run `flint explore`.',
    });
  }
  const parsed = ScreenModelSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(
      `Screen Model failed validation (${path}):\n${formatZodError(parsed.error)}`,
      { hint: 'Delete it and re-run `flint explore`.' },
    );
  }
  return parsed.data;
}

/** Read a model if it exists, else undefined — for first-run / diff baselines. */
export function tryReadModel(path: string): ScreenModel | undefined {
  return existsSync(path) ? readModel(path) : undefined;
}

// ---------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------

export interface ElementChange {
  elementId: string;
  /** Field-level summary, e.g. `name`, `states.visible`, `selectorCandidates`. */
  changed: string[];
}

export interface PageDiff {
  pageId: string;
  urlPattern: string;
  addedElements: string[];
  removedElements: string[];
  changedElements: ElementChange[];
}

export interface ScreenModelDiff {
  addedPages: string[];
  removedPages: string[];
  changedPages: PageDiff[];
  /** True when nothing at all differs — drives the `--diff` exit code. */
  unchanged: boolean;
}

/**
 * Compare two Screen Models. Pages and elements are matched by id, which is
 * why the extractor must derive ids from stable facts rather than DOM order —
 * otherwise every run would report the whole app as changed.
 *
 * Phase 6 maps `changedElements` onto the Suite Index to answer "which tests
 * will this UI change break?".
 */
export function diffModels(before: ScreenModel, after: ScreenModel): ScreenModelDiff {
  const beforePages = indexBy(before.pages, (p) => p.id);
  const afterPages = indexBy(after.pages, (p) => p.id);

  const addedPages = [...afterPages.keys()].filter((id) => !beforePages.has(id)).sort();
  const removedPages = [...beforePages.keys()].filter((id) => !afterPages.has(id)).sort();

  const changedPages: PageDiff[] = [];
  for (const id of [...afterPages.keys()].filter((k) => beforePages.has(k)).sort()) {
    const pageDiff = diffPage(beforePages.get(id)!, afterPages.get(id)!);
    if (
      pageDiff.addedElements.length > 0 ||
      pageDiff.removedElements.length > 0 ||
      pageDiff.changedElements.length > 0
    ) {
      changedPages.push(pageDiff);
    }
  }

  return {
    addedPages,
    removedPages,
    changedPages,
    unchanged: addedPages.length === 0 && removedPages.length === 0 && changedPages.length === 0,
  };
}

function diffPage(before: Page, after: Page): PageDiff {
  const beforeEls = indexBy(before.elements, (e) => e.id);
  const afterEls = indexBy(after.elements, (e) => e.id);

  const addedElements = [...afterEls.keys()].filter((id) => !beforeEls.has(id)).sort();
  const removedElements = [...beforeEls.keys()].filter((id) => !afterEls.has(id)).sort();

  const changedElements: ElementChange[] = [];
  for (const id of [...afterEls.keys()].filter((k) => beforeEls.has(k)).sort()) {
    const changed = elementFieldChanges(beforeEls.get(id)!, afterEls.get(id)!);
    if (changed.length > 0) changedElements.push({ elementId: id, changed });
  }

  return {
    pageId: after.id,
    urlPattern: after.urlPattern,
    addedElements,
    removedElements,
    changedElements,
  };
}

/**
 * Which fields of an element differ. `boundingBox` is deliberately excluded —
 * pixel jitter between runs is not drift and would make every diff noisy.
 */
function elementFieldChanges(before: Element, after: Element): string[] {
  const changed: string[] = [];
  const compare = (field: string, a: unknown, b: unknown): void => {
    if (stableStringify(a) !== stableStringify(b)) changed.push(field);
  };

  compare('role', before.role, after.role);
  compare('name', before.name, after.name);
  compare('testId', before.testId, after.testId);
  compare('domId', before.domId, after.domId);
  compare('text', before.text, after.text);
  compare('tagName', before.tagName, after.tagName);
  compare('states', before.states, after.states);
  compare('framePath', before.framePath, after.framePath);
  compare('selectorCandidates', before.selectorCandidates, after.selectorCandidates);
  return changed;
}

function indexBy<T>(items: T[], key: (item: T) => string): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) map.set(key(item), item);
  return map;
}

/** One-line-per-change human summary for the CLI. */
export function formatDiff(diff: ScreenModelDiff): string {
  if (diff.unchanged) return 'No changes.';
  const lines: string[] = [];
  for (const id of diff.addedPages) lines.push(`+ page    ${id}`);
  for (const id of diff.removedPages) lines.push(`- page    ${id}`);
  for (const page of diff.changedPages) {
    lines.push(`~ page    ${page.pageId} (${page.urlPattern})`);
    for (const el of page.addedElements) lines.push(`    + element ${el}`);
    for (const el of page.removedElements) lines.push(`    - element ${el}`);
    for (const el of page.changedElements) {
      lines.push(`    ~ element ${el.elementId} [${el.changed.join(', ')}]`);
    }
  }
  return lines.join('\n');
}
