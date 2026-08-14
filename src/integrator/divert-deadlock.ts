import { join } from 'node:path';
import type { WriteDecision } from './writer.js';

/**
 * Explaining the one compile-gate failure that never fixes itself.
 *
 * When a generated file has been hand-edited, Flint keeps the human's version
 * and writes its own beside it as `*.flint.ts` (see `writer.ts`). That is the
 * right call for the file, and it creates a deadlock for the run: the newly
 * generated specs are written against Flint's page object, the gate typechecks
 * them against the human's, and the two no longer agree. tsc says
 *
 *     tests/cart.spec.ts(14,22): error TS2551: Property 'addToCartButton2' does
 *     not exist on type 'InventoryHtmlPage'. Did you mean 'addToCartButton'?
 *
 * which is true, unhelpful, and identical on every subsequent run. The gate is
 * behaving correctly — it is refusing to write a suite it knows is broken — but
 * a failure that repeats forever and does not name its own cause reads like a
 * bug in Flint.
 *
 * So: when the gate fails and the run diverted anything, say what happened and
 * give the two ways out. Pure and table-testable; the caller prints the lines.
 */

export interface DeadlockAdviceOptions {
  decisions: readonly WriteDecision[];
  /** tsc diagnostics from the failed gate. */
  errors: readonly string[];
  /** `config.suiteDir`, so the printed paths are copy-pasteable. */
  suiteDir: string;
}

/**
 * Advice lines, or empty when the failure has nothing to do with divergence.
 *
 * Deliberately not filtered by which file each error names: the diverted file is
 * the page object, and the errors land in the *specs* that import it, so
 * matching paths would suppress exactly the case this exists for.
 */
export function divertDeadlockAdvice(options: DeadlockAdviceOptions): string[] {
  const diverted = options.decisions.filter((d) => d.outcome === 'diverted');
  if (diverted.length === 0) return [];

  const lines: string[] = [];
  lines.push('');
  lines.push(
    membershipErrors(options.errors)
      ? 'That is a collision, not a defect in the generated code. Flint could not'
      : 'Flint also could not overwrite these, which may be why. It could not',
  );
  lines.push('overwrite these files — their contents no longer match the marker Flint');
  lines.push('last wrote, so what is on disk was kept:');
  for (const decision of diverted) {
    lines.push(`  ${join(options.suiteDir, decision.path)}`);
    lines.push(
      `      Flint's version was written beside it as ${join(options.suiteDir, decision.targetPath)}`,
    );
  }
  lines.push('');
  // Deliberately not "your edits": `flint verify --repair` rewrites page objects
  // and specs in place, and blaming a human for a file Flint itself changed
  // sends them looking for an edit they never made.
  lines.push('That happens when you edit a generated file — and also when an earlier');
  lines.push('`flint verify --repair` rewrote one. Either way, the new specs are written');
  lines.push('against Flint’s version and the gate typechecks them against the version on');
  lines.push('disk, so every run fails here in exactly the same way.');
  lines.push('');
  lines.push('Two ways out:');
  lines.push('  1. Merge what you want from the .flint.ts copy into the file, then re-run.');
  lines.push('  2. Give the file back to Flint — delete both and re-run:');
  for (const decision of diverted) {
    lines.push(
      `       rm ${join(options.suiteDir, decision.path)} ${join(options.suiteDir, decision.targetPath)}`,
    );
  }
  return lines;
}

/**
 * True when tsc is complaining that a member is missing from a type — the exact
 * shape a page-object divergence produces (TS2339 / TS2551), as opposed to a
 * syntax or import error that would fail whether anything was diverted or not.
 */
function membershipErrors(errors: readonly string[]): boolean {
  return errors.some((line) => /error TS(2339|2551|2554|2353):/.test(line));
}
