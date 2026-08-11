import { sha256 } from '../shared/hashing.js';

/**
 * Managed-file markers.
 *
 * Flint writes files into a suite it does not own. The marker is how it tells
 * three cases apart, which is the whole basis of "extend, don't duplicate":
 *
 *   - **hand-written** — no marker. Flint never rewrites these.
 *   - **managed** — marker present and the hash still matches the content.
 *     Flint may regenerate freely; nobody has touched it.
 *   - **hand-edited** — marker present but the hash no longer matches. A human
 *     changed generated code. Regenerating would destroy their work, so Phase 4
 *     emits a sibling file and reports it instead.
 *
 * The hash covers the file body with the marker line removed, so writing the
 * marker cannot change the hash it contains.
 */

/** Marker line format: `/* @flint:managed <sha256> *\/` */
export const MANAGED_MARKER_PREFIX = '@flint:managed';

/** Matches the marker line anywhere in a file, capturing the hash. */
const MARKER_RE = /^[ \t]*\/\*[ \t]*@flint:managed[ \t]+([a-f0-9]{6,64})[ \t]*\*\/[ \t]*\r?\n?/m;

export type ManagedStatus = 'hand-written' | 'managed' | 'hand-edited';

export interface ManagedInfo {
  status: ManagedStatus;
  /** The hash recorded in the marker, when there is one. */
  recordedHash?: string;
  /** The hash of the current content, when there is a marker to compare to. */
  actualHash?: string;
}

/** Hash of a file body with any marker line stripped. */
export function contentHash(source: string): string {
  return sha256(stripMarker(source));
}

/** Remove the marker line, leaving the rest of the file byte-identical. */
export function stripMarker(source: string): string {
  return source.replace(MARKER_RE, '');
}

/** The hash recorded in a file's marker, or undefined when unmarked. */
export function readMarker(source: string): string | undefined {
  return MARKER_RE.exec(source)?.[1];
}

/**
 * Prepend a marker whose hash describes `body`.
 *
 * Idempotent: re-stamping already-stamped content replaces the old marker
 * rather than accumulating them, so a regenerated file stays byte-identical to
 * a freshly generated one. That is a hard requirement — Phase 4's determinism
 * check compares exactly this output.
 */
export function withMarker(body: string): string {
  const clean = stripMarker(body);
  return `/* ${MANAGED_MARKER_PREFIX} ${sha256(clean)} */\n${clean}`;
}

/**
 * Classify a file. Called on every file in the suite during indexing.
 *
 * A marker whose hash does not match means a human edited generated code —
 * the single most important thing the index tells Phase 4.
 */
export function classify(source: string): ManagedInfo {
  const recordedHash = readMarker(source);
  if (recordedHash === undefined) return { status: 'hand-written' };

  const actualHash = sha256(stripMarker(source));
  // Markers may carry a truncated hash; compare on the recorded length so a
  // shortened marker is not misread as a mismatch.
  const matches = actualHash.slice(0, recordedHash.length) === recordedHash;
  return {
    status: matches ? 'managed' : 'hand-edited',
    recordedHash,
    actualHash,
  };
}
