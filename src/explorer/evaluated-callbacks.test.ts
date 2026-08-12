import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Guard for a class of bug that is invisible at runtime until it costs a crawl.
 *
 * Functions passed to `locator.evaluate` / `page.evaluate` are serialised with
 * `Function.prototype.toString()` and re-parsed inside the browser, where none
 * of this module's scope exists. A bundler with `keepNames` enabled — esbuild,
 * which is what `tsx` and most dev runners use — rewrites
 *
 *     const cssPath = () => { … }
 * into
 *     const cssPath = __name(() => { … }, 'cssPath')
 *
 * and `__name` is not defined in the page. Every read then threw a
 * `ReferenceError` that the surrounding `.catch()` swallowed, so `flint explore`
 * reported pages with zero elements as though the application were empty. It
 * reproduced under `pnpm cli` and not under the compiled binary, which is the
 * worst possible split.
 *
 * The invariant: no *named* function binding inside an evaluated callback.
 * Anonymous callbacks passed inline (`nodes.map((n) => …)`) are untouched by
 * keepNames and remain fine.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));

/** Source files that pass callbacks into the browser. */
const FILES = ['extractor.ts', 'route-discovery.ts', 'wait.ts', 'flows.ts', 'validator.ts'];

/**
 * A named arrow assigned to a binding, or a named function declaration — the
 * two forms keepNames rewrites. Requiring the `=>` keeps an ordinary
 * parenthesised expression (`const n = (a ?? b) - c;`) from matching.
 */
const NAMED_BINDING =
  /(?:const|let|var)\s+\w+\s*(?::[^=]*)?=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*(?::[^=]*?)?=>|\bfunction\s+\w+\s*\(/;

/**
 * Extract the body of each `evaluate(`/`evaluateAll(` argument by brace
 * matching. Crude, but it only has to be right about this repo's own source.
 */
function evaluatedCallbacks(source: string): string[] {
  const bodies: string[] = [];
  const opener = /\.(?:evaluate|evaluateAll|evaluateHandle)\(/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(source)) !== null) {
    let depth = 0;
    let i = match.index + match[0].length - 1;
    const start = i;
    for (; i < source.length; i += 1) {
      if (source[i] === '(') depth += 1;
      else if (source[i] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    bodies.push(source.slice(start, i + 1));
  }
  return bodies;
}

/** Comments describing the pattern must not be mistaken for the pattern. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('callbacks evaluated in the browser', () => {
  it.each(FILES)('%s declares no named function inside an evaluate', (file) => {
    let source: string;
    try {
      source = readFileSync(join(HERE, file), 'utf8');
    } catch {
      return; // file may not exist in a future refactor; the others still guard
    }
    for (const body of evaluatedCallbacks(source).map(stripComments)) {
      expect(
        NAMED_BINDING.test(body),
        `${file}: an evaluated callback declares a named function. A bundler with ` +
          `keepNames rewrites it to __name(...), which does not exist in the page, ` +
          `and every read fails silently. Inline the helper instead.\n\n${body.slice(0, 400)}`,
      ).toBe(false);
    }
  });

  it('detects the pattern it is meant to catch', () => {
    // Proof the guard is not vacuous.
    const bad = `x.evaluate((node) => { const helper = () => 1; return helper(); })`;
    expect(evaluatedCallbacks(bad)).toHaveLength(1);
    expect(NAMED_BINDING.test(evaluatedCallbacks(bad)[0]!)).toBe(true);
  });
});
