import { describe, it, expect } from 'vitest';
import {
  classify,
  contentHash,
  readMarker,
  stripMarker,
  withMarker,
  MANAGED_MARKER_PREFIX,
} from './managed.js';

/**
 * The marker decides whether Phase 4 may overwrite a file. Getting
 * "hand-edited" wrong in one direction destroys a human's work; getting it
 * wrong in the other leaves stale generated code forever.
 */

const BODY = `import { test } from '@playwright/test';\n\ntest('does a thing', async () => {});\n`;

describe('withMarker', () => {
  it('prepends a marker line', () => {
    const stamped = withMarker(BODY);
    expect(stamped.startsWith(`/* ${MANAGED_MARKER_PREFIX} `)).toBe(true);
    expect(stamped).toContain("test('does a thing'");
  });

  it('is idempotent — re-stamping does not stack markers', () => {
    const once = withMarker(BODY);
    const twice = withMarker(once);
    expect(twice).toBe(once);
    expect(twice.match(/@flint:managed/g)).toHaveLength(1);
  });

  it('records a hash of the body without the marker', () => {
    const stamped = withMarker(BODY);
    expect(readMarker(stamped)).toBe(contentHash(BODY));
  });

  it('leaves the body byte-identical below the marker', () => {
    expect(stripMarker(withMarker(BODY))).toBe(BODY);
  });
});

describe('classify', () => {
  it('reports an unmarked file as hand-written', () => {
    expect(classify(BODY).status).toBe('hand-written');
  });

  it('reports an untouched generated file as managed', () => {
    expect(classify(withMarker(BODY)).status).toBe('managed');
  });

  it('reports an edited generated file as hand-edited', () => {
    const edited = withMarker(BODY).replace('does a thing', 'does another thing');
    const info = classify(edited);
    expect(info.status).toBe('hand-edited');
    expect(info.recordedHash).not.toBe(info.actualHash);
  });

  it('detects an edit that only adds whitespace', () => {
    // Formatting a generated file still counts: regenerating would discard it.
    const edited = `${withMarker(BODY)}\n`;
    expect(classify(edited).status).toBe('hand-edited');
  });

  it('detects a deletion as well as an addition', () => {
    const edited = withMarker(BODY).replace("test('does a thing', async () => {});\n", '');
    expect(classify(edited).status).toBe('hand-edited');
  });

  it('accepts a truncated hash in the marker', () => {
    const full = withMarker(BODY);
    const short = full.replace(
      /(@flint:managed )([a-f0-9]+)/,
      (_m, p, h) => `${p}${h.slice(0, 12)}`,
    );
    expect(classify(short).status).toBe('managed');
  });

  it('tolerates leading whitespace and tabs around the marker', () => {
    const indented = `  /*\t${MANAGED_MARKER_PREFIX}\t${contentHash(BODY)}\t*/\n${BODY}`;
    expect(classify(indented).status).toBe('managed');
  });

  it('does not treat a mention of the marker in prose as a marker', () => {
    const prose = `// files carry an ${MANAGED_MARKER_PREFIX} header\n${BODY}`;
    expect(classify(prose).status).toBe('hand-written');
  });

  it('handles an empty file', () => {
    expect(classify('').status).toBe('hand-written');
    expect(classify(withMarker('')).status).toBe('managed');
  });

  it('handles CRLF line endings', () => {
    const crlf = `/* ${MANAGED_MARKER_PREFIX} ${sha(BODY.replace(/\n/g, '\r\n'))} */\r\n${BODY.replace(/\n/g, '\r\n')}`;
    expect(classify(crlf).status).toBe('managed');
  });
});

/** Local helper mirroring contentHash for the CRLF case. */
function sha(body: string): string {
  return contentHash(body);
}
