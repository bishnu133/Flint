import type { SuiteIndex } from '../schemas/suite-index.js';
import { ownedSpecFiles } from '../planner/supersede.js';

/**
 * Refuse to replace a spec that has tests with one that has none.
 *
 * A live `ci` run took a 13-test suite down to 3 and reported success: the
 * planner marked every case of two features a duplicate, and the emitter wrote
 * their spec files empty. The compile gate cannot see this — an empty spec
 * typechecks perfectly — so the check has to count tests.
 *
 * **Zero is the line, not "fewer".** The first version of this guard refused any
 * net decrease, and the operator's very next run tripped it at 12 tests against
 * 13. That is not data loss; planning is a model call, and a case merging into
 * another between runs is ordinary. A guard that fires on ordinary variation is
 * one people learn to pass `--allow-...` to by reflex, which costs exactly the
 * protection it was built for.
 *
 * A file that held tests and would hold none is different in kind: nothing was
 * regenerated there, it was erased. That is the failure worth blocking on, and
 * it is the failure that actually happened.
 */

export interface EmptiedSpec {
  featureId: string;
  /** Spec files this feature owns that currently hold tests. */
  files: string[];
  /** Tests in them right now. */
  tests: number;
}

export interface ShrinkCheckOptions {
  /** The suite as scanned **before** the run. */
  baseline: SuiteIndex;
  /** What the batch will write, per feature: `liveTests + degraded`. */
  emitted: Array<{ featureId: string; tests: number }>;
}

/** Features whose spec would go from some tests to none. Empty means safe. */
export function emptiedSpecs(options: ShrinkCheckOptions): EmptiedSpec[] {
  const out: EmptiedSpec[] = [];
  for (const feature of options.emitted) {
    if (feature.tests > 0) continue;
    const files = [...ownedSpecFiles(options.baseline, feature.featureId)].sort();
    const tests = testsInOwnedSpecs(options.baseline, new Set(files));
    // No owned file, or an owned file that was already empty: nothing is lost.
    if (tests === 0) continue;
    out.push({ featureId: feature.featureId, files, tests });
  }
  return out.sort((a, b) => a.featureId.localeCompare(b.featureId));
}

/** Tests living in the named spec files. */
export function testsInOwnedSpecs(index: SuiteIndex, files: ReadonlySet<string>): number {
  let total = 0;
  for (const spec of index.specs) {
    if (files.has(spec.file)) total += spec.testTitles.length;
  }
  return total;
}

/** Every spec file the named features own. */
export function ownedByRun(index: SuiteIndex, featureIds: readonly string[]): Set<string> {
  const owned = new Set<string>();
  for (const featureId of featureIds) {
    for (const file of ownedSpecFiles(index, featureId)) owned.add(file);
  }
  return owned;
}
