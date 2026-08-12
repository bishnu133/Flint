import type { SuiteIndex } from '../schemas/suite-index.js';

/**
 * Hide a feature's own previously-generated tests from its next plan.
 *
 * Re-running the pipeline for one feature must be idempotent. It was not:
 *
 *   flint plan login     -> 3 new cases + 2 blocked
 *   flint generate login -> writes login.spec.ts with those 3 tests
 *   flint plan login     -> the indexer finds those 3 tests in the suite,
 *                           marks all 3 `skipped-duplicate`
 *   flint generate login -> rewrites login.spec.ts with ONLY the 2 blocked
 *                           fixmes — the 3 working tests are gone
 *
 * The planner was not wrong about the facts: those titles really were in the
 * suite. It was wrong about what they meant. A test Flint generated for feature
 * X is not prior art that a re-plan of X should defer to — it is the previous
 * answer to the very question being asked, and the new plan supersedes it.
 *
 * Only tests in **managed** spec files are hidden. A managed file is one Flint
 * wrote and nobody has touched since, so nothing is lost by regenerating it.
 * The moment a human edits that file it becomes `hand-edited`, and their tests
 * count as real coverage again — a re-plan will defer to them, which is the
 * conservative direction.
 *
 * Hand-written tests tagged for the same feature are always kept: those are
 * genuine prior art and duplicating them is exactly what the planner should
 * avoid.
 */
export function supersedeOwnGeneratedTests(index: SuiteIndex, featureId: string): SuiteIndex {
  const covered = index.coverageMap[featureId];
  if (covered === undefined || covered.length === 0) return index;

  const managed = new Set(index.managedFiles);
  // Titles living in a spec file Flint owns outright.
  const ours = new Set<string>();
  for (const spec of index.specs) {
    if (!managed.has(spec.file)) continue;
    for (const title of spec.testTitles) ours.add(title);
  }
  if (ours.size === 0) return index;

  const remaining = covered.filter((title) => !ours.has(title));
  if (remaining.length === covered.length) return index;

  const coverageMap = { ...index.coverageMap };
  if (remaining.length === 0) delete coverageMap[featureId];
  else coverageMap[featureId] = remaining;

  return { ...index, coverageMap };
}

/** How many of a feature's covered titles this run will supersede. */
export function countSuperseded(index: SuiteIndex, featureId: string): number {
  const before = index.coverageMap[featureId]?.length ?? 0;
  const after = supersedeOwnGeneratedTests(index, featureId).coverageMap[featureId]?.length ?? 0;
  return before - after;
}
