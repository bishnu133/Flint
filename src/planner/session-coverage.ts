import type { CoverageMap } from '../schemas/suite-index.js';
import type { TestPlan } from '../schemas/test-plan.js';
import { planHistoryCoverage } from './store.js';

/**
 * Coverage as seen by the *next* feature in a multi-feature run.
 *
 * A batch run plans several features in a row, and each one must be deduped
 * against the ones already planned in the same run — otherwise two features
 * both plan "user can sign in" and the suite gets it twice.
 *
 * The obvious way to arrange that is to persist each plan as it is produced, so
 * the next feature reads it back off disk. `flint ci` did exactly that, and it
 * was wrong for a reason that only shows up when the run fails: the compile gate
 * runs *after* every feature is planned, and a gate failure writes no code. The
 * plans were already on disk by then, claiming coverage for tests that do not
 * exist — which is how `explore --diff` came to report nine tests as
 * `(file unknown)`.
 *
 * So the run keeps its plans in memory and persists them only once the code is
 * written. This function supplies what the disk used to: history for features
 * this run is not touching, plus the plans made so far in this run.
 *
 * Every feature in the run is dropped from the on-disk history, not just the one
 * being planned. Their stored plans describe the suite as it was *before* this
 * run, and this run is about to replace them; deduping a new plan against a
 * predecessor that is being overwritten is the same mistake `excludeFeature`
 * exists to prevent, one feature over.
 */
export interface SessionCoverageOptions {
  projectRoot: string;
  /** Every feature this run will plan, including ones not yet reached. */
  runFeatures: readonly string[];
  /** Plans produced so far in this run, keyed by feature id. */
  planned: ReadonlyMap<string, TestPlan>;
  /** The feature being planned right now — its own plans are never coverage. */
  excludeFeature: string;
}

export function sessionCoverage(options: SessionCoverageOptions): CoverageMap {
  const coverage = planHistoryCoverage(options.projectRoot);
  for (const featureId of options.runFeatures) delete coverage[featureId];

  for (const [featureId, plan] of [...options.planned].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (featureId === options.excludeFeature) continue;
    // Same rule as the on-disk version: only cases the emitter will actually
    // write count. A skipped duplicate is already represented by the test it
    // duplicates, and a blocked case has no test at all.
    const titles = plan.cases
      .filter((c) => c.status === 'new' || c.status === 'update-existing')
      .map((c) => c.title);
    if (titles.length === 0) continue;
    coverage[featureId] = [...new Set(titles)].sort((a, b) => a.localeCompare(b));
  }

  return coverage;
}
