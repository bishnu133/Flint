/**
 * The degradation of last resort: a test repair could not fix becomes
 * `test.fixme` carrying the reason.
 *
 * A bare `test.fixme` with no explanation is how a suite silently accumulates
 * dead tests — six months later nobody knows whether it was a broken selector
 * or a real bug, so nobody touches it. Everything a human needs to decide goes
 * in the file where they will find the problem: the failure class, what the
 * loop tried, and the last error.
 *
 * ## Idempotence is the requirement, not a nicety
 *
 * Four times in Phase 4, Flint read its own previous output as somebody else's
 * input, and the damage was silent every time. This function is the same hazard
 * in miniature: run it twice on one test and it would stack comment blocks and
 * rewrite `test.fixme` into `test.fixme.fixme`, compounding on every verify
 * until the file no longer parses. So a test that already carries the marker is
 * left alone, and the marker is checked for before anything is written.
 */

/** Marks a block as Flint's, so a second pass recognises its own work. */
export const FIXME_MARKER = '@flint:repair-failed';

export interface FixmeResult {
  source: string;
  /** False when the file already carried the block, or the test was not found. */
  changed: boolean;
  /** Why nothing happened, for the log. */
  reason?: string;
}

/**
 * Convert `test('title', …)` into `test.fixme('title', …)` with a comment block.
 *
 * Matches on the exact title, which is what the RunReport carries. A title the
 * file does not contain leaves the source untouched and says so — guessing at
 * which test was meant is how a repair loop disables the wrong one.
 */
export function applyFixme(source: string, title: string, comment: readonly string[]): FixmeResult {
  const call = findTestCall(source, title);
  if (call === undefined) {
    return { source, changed: false, reason: `no test titled "${title}" in this file` };
  }
  if (alreadyMarked(source, call.start)) {
    return { source, changed: false, reason: 'already marked by a previous run' };
  }

  const indent = indentOf(source, call.start);
  const block = renderComment(comment, indent);
  const patched =
    source.slice(0, call.start) + block + indent + `test.fixme(` + source.slice(call.openParen + 1);
  return { source: patched, changed: true };
}

interface TestCall {
  /** Index of the `t` in `test(`. */
  start: number;
  /** Index of the `(` that opens the call. */
  openParen: number;
}

/**
 * Locate `test('title'` / `test("title"` for one exact title.
 *
 * Deliberately syntactic rather than a parse: the Emitter writes these calls,
 * their shape is known, and a ts-morph round trip here would reformat the whole
 * file. `test.fixme` and `test.skip` forms are matched too, so an already
 * modified test is found and then declined rather than duplicated.
 */
function findTestCall(source: string, title: string): TestCall | undefined {
  const pattern = /(?<![\w.])test(?:\.(?:fixme|skip|only|slow))?\s*\(\s*(['"`])/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const quote = match[1]!;
    const titleStart = match.index + match[0].length;
    const titleEnd = source.indexOf(quote, titleStart);
    if (titleEnd === -1) continue;
    if (source.slice(titleStart, titleEnd) !== title) continue;
    return { start: match.index, openParen: source.indexOf('(', match.index) };
  }
  return undefined;
}

/** True when a Flint block already sits above this call. */
function alreadyMarked(source: string, callStart: number): boolean {
  // Look back over the comment block immediately preceding the call. Scanning
  // the whole file would refuse to mark a second failing test in a file that
  // already has one marked.
  const before = source.slice(Math.max(0, callStart - 4000), callStart);
  const trailing = before.split(/\n\s*\n/).pop() ?? '';
  return trailing.includes(FIXME_MARKER);
}

function indentOf(source: string, index: number): string {
  const lineStart = source.lastIndexOf('\n', index - 1) + 1;
  return source.slice(lineStart, index);
}

function renderComment(comment: readonly string[], indent: string): string {
  const lines = [`${indent}/**`, `${indent} * ${FIXME_MARKER}`, `${indent} *`];
  for (const line of comment) {
    lines.push(line === '' ? `${indent} *` : `${indent} * ${line}`);
  }
  lines.push(`${indent} */`, '');
  return lines.join('\n');
}
