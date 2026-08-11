import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CoverageMap } from '../schemas/suite-index.js';
import type { TestPlan } from '../schemas/test-plan.js';
import { ConfigError } from '../shared/errors.js';
import { parsePlan } from './planner.js';

/**
 * TestPlan persistence, alongside the Screen Model and Suite Index under
 * `.flint/`.
 *
 * Plans are kept per feature rather than overwritten into one file: Phase 6
 * reads plan history to answer what was planned before, and the Suite Index
 * merges it into the coverage map so a feature planned but not yet generated
 * still counts as known.
 */

export const PLANS_DIR = join('.flint', 'plans');

export function plansDir(projectRoot: string): string {
  return join(projectRoot, PLANS_DIR);
}

export function planPath(projectRoot: string, featureId: string): string {
  return join(plansDir(projectRoot), `${featureId}.plan.json`);
}

/** Rendered markdown sits beside the JSON, same stem. */
export function renderedPlanPath(projectRoot: string, featureId: string): string {
  return join(plansDir(projectRoot), `${featureId}.plan.md`);
}

export function writePlan(path: string, plan: TestPlan): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
}

export function writeRenderedPlan(path: string, markdown: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, markdown, 'utf8');
}

export function readPlan(path: string): TestPlan {
  if (!existsSync(path)) {
    throw new ConfigError(`No TestPlan at ${path}.`, {
      hint: 'Run `flint plan <feature>` first to create one.',
    });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ConfigError(`TestPlan is not valid JSON: ${path}.`, {
      cause: err,
      hint: 'Delete it and re-run `flint plan`.',
    });
  }
  return parsePlan(raw, path);
}

export function tryReadPlan(path: string): TestPlan | undefined {
  return existsSync(path) ? readPlan(path) : undefined;
}

/** Every stored plan, in stable order. Unreadable plans are skipped. */
export function readAllPlans(projectRoot: string): TestPlan[] {
  const dir = plansDir(projectRoot);
  if (!existsSync(dir)) return [];
  const plans: TestPlan[] = [];
  for (const name of readdirSync(dir).sort((a, b) => a.localeCompare(b))) {
    if (!name.endsWith('.plan.json')) continue;
    try {
      plans.push(readPlan(join(dir, name)));
    } catch {
      // A corrupt plan must not stop the others from informing coverage.
    }
  }
  return plans;
}

/**
 * Plan history as a coverage map, for the Suite Indexer.
 *
 * Only cases the Emitter will actually write count as coverage. A
 * `skipped-duplicate` case is already represented by the test it duplicates,
 * and a `blocked` case has no test at all — counting either would make a
 * feature look covered when nothing runs.
 */
export function planHistoryCoverage(
  projectRoot: string,
  options: {
    /**
     * Feature whose own history must NOT count as coverage — the one being
     * re-planned. Without this, planning a feature twice dedupes the new plan
     * against the old one: every case comes back `skipped-duplicate`, with
     * `duplicateOf` naming tests that were never generated. A re-plan
     * supersedes its predecessor; only *other* features' plans are coverage.
     */
    excludeFeature?: string;
  } = {},
): CoverageMap {
  const coverage: CoverageMap = {};
  for (const plan of readAllPlans(projectRoot)) {
    if (plan.featureId === options.excludeFeature) continue;
    const titles = plan.cases
      .filter((c) => c.status === 'new' || c.status === 'update-existing')
      .map((c) => c.title);
    if (titles.length === 0) continue;
    coverage[plan.featureId] = [...new Set([...(coverage[plan.featureId] ?? []), ...titles])].sort(
      (a, b) => a.localeCompare(b),
    );
  }
  return coverage;
}

/** Human-readable summary for the CLI. */
export function formatPlanSummary(plan: TestPlan): string {
  const byStatus = new Map<string, number>();
  for (const testCase of plan.cases) {
    byStatus.set(testCase.status, (byStatus.get(testCase.status) ?? 0) + 1);
  }
  const lines = [`Feature:          ${plan.featureId}`, `Cases:            ${plan.cases.length}`];
  for (const [status, count] of [...byStatus.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`  ${status.padEnd(16)}${count}`);
  }
  const needsSetup = plan.cases.filter(
    (c) => c.prerequisites !== undefined && c.prerequisites.length > 0,
  );
  if (needsSetup.length > 0) lines.push(`Needing setup:    ${needsSetup.length}`);
  if (plan.openQuestions !== undefined && plan.openQuestions.length > 0) {
    lines.push('', `Open questions:   ${plan.openQuestions.length}`);
    for (const question of plan.openQuestions) lines.push(`  ? ${question}`);
  }
  return lines.join('\n');
}
