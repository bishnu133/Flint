import { createHash } from 'node:crypto';

/**
 * Deterministic JSON stringify with sorted object keys.
 *
 * Guarantees byte-identical output for value-equal inputs regardless of key
 * insertion order. Used for content hashing, fixture keys, and managed-file
 * markers where determinism is a hard project requirement.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortValue(record[key]);
    }
    return sorted;
  }
  return value;
}

/** SHA-256 hex digest of a string. */
export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Stable SHA-256 of any JSON-serializable value (key order independent). */
export function hashValue(value: unknown): string {
  return sha256(stableStringify(value));
}
