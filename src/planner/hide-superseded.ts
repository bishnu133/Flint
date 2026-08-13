import type { SuiteIndex } from '../schemas/suite-index.js';
import { supersedeOwnGeneratedTests } from './supersede.js';

/**
 * Hide a feature's own generated tests from its next plan — everywhere the
 * planner can see them, not just in the coverage map.
 *
 * `supersedeOwnGeneratedTests` removes the feature's own titles from
 * `coverageMap`. That is not enough, and a live run showed why. The Context
 * Builder renders the index twice over: once as "Coverage by feature id"
 * (counts, from the map) and once as **"Existing tests (title — file)"**, which
 * walks `index.specs[].testTitles` directly. The second list still carried the
 * very tests superseding had just hidden, so the planner read them as prior art
 * and marked the whole new plan `skipped-duplicate`:
 *
 *   flint ci  ->  cart: 8 case(s)      ... every one a duplicate
 *                 login: 4 case(s)     ... every one a duplicate
 *                 Wrote 3 file(s)
 *                 Tests: 3   (the suite had 13)
 *
 * Ten working tests were deleted and the run reported success. This is the same
 * failure the coverage-map fix was written for, one layer down — Flint reading
 * its own previous output as somebody else's input.
 *
 * So this hides the superseded titles from `specs` as well. Only titles the
 * feature's own coverage claims **and** that live in a managed file are hidden:
 * another feature's generated tests are genuine prior art, and a hand-edited
 * file means a human owns those tests now, so both stay visible.
 *
 * Kept beside `supersede.ts` rather than inside it because that module is a
 * frozen Phase 3 file (CLAUDE.md rule 2). Everything the planner is given goes
 * through here.
 */
export function hideSupersededTests(index: SuiteIndex, featureId: string): SuiteIndex {
  const covered = index.coverageMap[featureId];
  if (covered === undefined || covered.length === 0) return index;

  const managed = new Set(index.managedFiles);
  const claimed = new Set(covered);

  // The titles to hide: this feature's, in a file Flint owns outright.
  const hidden = new Set<string>();
  for (const spec of index.specs) {
    if (!managed.has(spec.file)) continue;
    for (const title of spec.testTitles) {
      if (claimed.has(title)) hidden.add(title);
    }
  }
  if (hidden.size === 0) return index;

  const withoutCoverage = supersedeOwnGeneratedTests(index, featureId);
  return {
    ...withoutCoverage,
    // A spec left with no visible titles is kept, not dropped: it is still a
    // real file, and the emitter is about to rewrite it.
    specs: withoutCoverage.specs.map((spec) =>
      managed.has(spec.file)
        ? { ...spec, testTitles: spec.testTitles.filter((title) => !hidden.has(title)) }
        : spec,
    ),
  };
}

/**
 * How many tests live in the spec files a set of features owns.
 *
 * The baseline for `ci`'s shrink guard: a full run regenerates these files, so
 * the count afterwards must not be lower than the count before unless the
 * operator said so.
 */
export function testsInOwnedSpecs(index: SuiteIndex, ownedFiles: ReadonlySet<string>): number {
  let total = 0;
  for (const spec of index.specs) {
    if (ownedFiles.has(spec.file)) total += spec.testTitles.length;
  }
  return total;
}
