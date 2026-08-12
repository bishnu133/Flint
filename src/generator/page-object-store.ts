import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { FlintError } from '../shared/errors.js';
import { formatZodError } from '../shared/zod-format.js';

/**
 * What each generated page object currently contains, remembered across
 * features.
 *
 * Two features touching the same page must share one page object — that is a
 * Phase 4 exit criterion. Without a record of what a page object already
 * exposes, generating the second feature would emit a class containing only
 * *its* locators and silently overwrite the first feature's, breaking the spec
 * that imports them.
 *
 * The record deliberately stores element **ids**, not the emitted code: the
 * Screen Model stays the single source of truth for roles, names and
 * selectors. An id that has since disappeared from the model is dropped rather
 * than resurrected, so a page object cannot outlive the UI it addresses.
 *
 * Parsing the existing .ts file would be the alternative. It is rejected on
 * purpose — a page object a human has since edited would feed its edits back
 * into generation, and the whole managed/hand-edited distinction would blur.
 */

export const StoredActionSchema = z
  .object({
    kind: z.enum(['click', 'fill', 'select']),
    elementId: z.string().min(1),
  })
  .strict();

export const StoredPageObjectSchema = z
  .object({
    className: z.string().min(1),
    /** Screen Model page id — the identity a page object is keyed by. */
    pageId: z.string().min(1),
    /** Feature ids that have contributed to this page object, sorted. */
    features: z.array(z.string()),
    /** Element ids this page object exposes as locators, sorted. */
    elementIds: z.array(z.string()),
    /** Actions that became methods, sorted. */
    actions: z.array(StoredActionSchema),
  })
  .strict();
export type StoredPageObject = z.infer<typeof StoredPageObjectSchema>;

const RecordFileSchema = z
  .object({
    version: z.literal(1),
    pageObjects: z.array(StoredPageObjectSchema),
  })
  .strict();

export function pageObjectRecordPath(projectRoot: string): string {
  return join(projectRoot, '.flint', 'page-objects.json');
}

/** Read the record, or an empty list before anything has been generated. */
export function readPageObjectRecords(projectRoot: string): StoredPageObject[] {
  const path = pageObjectRecordPath(projectRoot);
  if (!existsSync(path)) return [];

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new FlintError(`The page-object record at ${path} is not valid JSON.`, {
      code: 'GENERATE',
      hint: 'Delete it and re-run `flint generate` for each feature.',
    });
  }

  const parsed = RecordFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new FlintError(
      `The page-object record at ${path} is malformed:\n${formatZodError(parsed.error)}`,
      { code: 'GENERATE', hint: 'Delete it and re-run `flint generate` for each feature.' },
    );
  }
  return parsed.data.pageObjects;
}

/** Write the record, sorted so the file is stable under version control. */
export function writePageObjectRecords(projectRoot: string, records: StoredPageObject[]): void {
  const path = pageObjectRecordPath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  const sorted = [...records].sort((a, b) => a.pageId.localeCompare(b.pageId));
  writeFileSync(path, `${JSON.stringify({ version: 1, pageObjects: sorted }, null, 2)}\n`, 'utf8');
}

/**
 * Merge freshly emitted records over the stored ones.
 *
 * Union, not replace: a page object accumulates what every feature needs from
 * that page. Records for pages this run never touched are carried through
 * untouched. Everything is sorted, so the merge is associative and the result
 * does not depend on which feature was generated first.
 */
export function mergePageObjectRecords(
  stored: StoredPageObject[],
  fresh: StoredPageObject[],
): StoredPageObject[] {
  const byPageId = new Map(stored.map((record) => [record.pageId, record]));

  for (const record of fresh) {
    const existing = byPageId.get(record.pageId);
    if (existing === undefined) {
      byPageId.set(record.pageId, normalize(record));
      continue;
    }
    byPageId.set(
      record.pageId,
      normalize({
        // The class name comes from the current run: a URL pattern that has
        // been renamed should rename its class rather than keep a stale one.
        className: record.className,
        pageId: record.pageId,
        features: [...existing.features, ...record.features],
        elementIds: [...existing.elementIds, ...record.elementIds],
        actions: [...existing.actions, ...record.actions],
      }),
    );
  }

  return [...byPageId.values()].sort((a, b) => a.pageId.localeCompare(b.pageId));
}

function normalize(record: StoredPageObject): StoredPageObject {
  return {
    className: record.className,
    pageId: record.pageId,
    features: unique(record.features).sort((a, b) => a.localeCompare(b)),
    elementIds: unique(record.elementIds).sort((a, b) => a.localeCompare(b)),
    actions: unique(record.actions.map((a) => `${a.kind}:${a.elementId}`))
      .sort((a, b) => a.localeCompare(b))
      .map((key) => {
        const [kind, elementId] = splitOnce(key);
        return { kind: kind as 'click' | 'fill' | 'select', elementId };
      }),
  };
}

function splitOnce(key: string): [string, string] {
  const at = key.indexOf(':');
  return [key.slice(0, at), key.slice(at + 1)];
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
