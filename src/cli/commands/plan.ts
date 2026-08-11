import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import { loadConfig } from '../../config/load.js';
import { createLogger } from '../../shared/logger.js';
import { FlintError } from '../../shared/errors.js';
import { AnthropicProvider } from '../../llm/index.js';
import { modelPath, readModel } from '../../explorer/screen-model-store.js';
import { scanSuite } from '../../indexer/scan.js';
import { readFeatureSpec, listFeatureIds } from '../../planner/feature-spec.js';
import { generatePlan } from '../../planner/planner.js';
import { renderPlan } from '../../planner/plan-renderer.js';
import {
  formatPlanSummary,
  planHistoryCoverage,
  planPath,
  renderedPlanPath,
  writePlan,
  writeRenderedPlan,
} from '../../planner/store.js';
import type { ExemplarFile } from '../../planner/context-builder.js';

/**
 * `flint plan <feature>` — Stage A.
 *
 * Reads the Screen Model and Suite Index that earlier phases produced, asks the
 * planner for a TestPlan, and writes both the JSON (for Phase 4) and a rendered
 * markdown view (for a human). No code is written here and no browser runs.
 */
export function registerPlan(program: Command): void {
  program
    .command('plan')
    .description('Generate a TestPlan (Stage A) for a feature spec')
    .argument('[feature]', 'feature id from kb/features/')
    .option('-d, --dir <dir>', 'project directory', '.')
    .option('--role <role>', 'use the Screen Model captured for a named role')
    .option('--review', 'print the rendered plan to the terminal', false)
    .option('--no-index', 'ignore the existing suite (no duplicate detection)')
    .option('-v, --verbose', 'verbose logging', false)
    .action(async (feature: string | undefined, opts: PlanOptions) => {
      await runPlan(feature, opts);
    });
}

interface PlanOptions {
  dir: string;
  role?: string;
  review: boolean;
  /** commander maps `--no-index` onto this, defaulting to true. */
  index: boolean;
  verbose: boolean;
}

async function runPlan(feature: string | undefined, opts: PlanOptions): Promise<void> {
  const projectRoot = resolve(process.cwd(), opts.dir);
  const logger = createLogger({ verbose: opts.verbose });
  const { config } = await loadConfig(projectRoot);

  if (feature === undefined || feature === '') {
    const available = listFeatureIds(projectRoot, config.kbDir);
    throw new FlintError('No feature id given.', {
      code: 'CLI',
      hint:
        available.length === 0
          ? `Write a spec under ${join(config.kbDir, 'features')} first.`
          : `Usage: flint plan <feature>. Available: ${available.join(', ')}`,
    });
  }

  const spec = readFeatureSpec(projectRoot, config.kbDir, feature);
  const model = readModel(modelPath(projectRoot, opts.role));

  // The index gives the planner duplicate detection; plan history keeps a
  // feature planned-but-not-yet-generated from being planned twice.
  const index = opts.index
    ? scanSuite({
        projectRoot,
        suiteDir: config.suiteDir,
        logger,
        planHistory: planHistoryCoverage(projectRoot, { excludeFeature: spec.frontmatter.id }),
      }).index
    : undefined;

  const conventions = readConventions(projectRoot, config.kbDir);
  const provider = new AnthropicProvider({ logger, logPrompts: config.debug.logPrompts });

  const result = await generatePlan({
    spec,
    model,
    provider,
    modelId: config.models.planner,
    tokenBudget: config.tokenBudgets.plan,
    logger,
    ...(index !== undefined ? { index } : {}),
    ...(conventions !== undefined ? { conventions } : {}),
    exemplars: readExemplars(projectRoot, config.suiteDir, index),
  });

  const markdown = renderPlan({
    plan: result.plan,
    spec,
    forcedDuplicates: result.forcedDuplicates,
    droppedContext: result.droppedContext,
  });

  const jsonPath = planPath(projectRoot, spec.frontmatter.id);
  const mdPath = renderedPlanPath(projectRoot, spec.frontmatter.id);
  writePlan(jsonPath, result.plan);
  writeRenderedPlan(mdPath, markdown);

  console.log('');
  console.log(formatPlanSummary(result.plan));
  if (result.retried) {
    console.log('');
    console.log('NOTE: the first attempt was rejected; the plan came from the retry.');
  }

  const blocked = result.plan.cases.filter((c) => c.status === 'blocked');
  if (blocked.length > 0) {
    console.log('');
    console.log(`${blocked.length} case(s) blocked — the spec needs UI the crawl never saw:`);
    for (const testCase of blocked) console.log(`  ! ${testCase.title}: ${testCase.blockedReason}`);
    console.log('  Re-run `flint explore`, or add a flow script to reach that state.');
  }

  console.log('');
  console.log(`Plan written to     ${jsonPath}`);
  console.log(`Review copy at      ${mdPath}`);

  if (opts.review) {
    console.log('');
    console.log(markdown);
  }

  // An uncovered acceptance criterion means the plan is incomplete against its
  // own spec — worth a non-zero exit so CI notices.
  const criteria = spec.frontmatter.acceptanceCriteria ?? [];
  if (criteria.length > 0) {
    const referenced = new Set(result.plan.cases.flatMap((c) => c.acceptanceRefs ?? []));
    const missing = criteria.map((_, i) => `AC${i + 1}`).filter((id) => !referenced.has(id));
    if (missing.length > 0) {
      console.log('');
      console.log(`WARNING: no case covers ${missing.join(', ')}. See the checklist in the plan.`);
      process.exitCode = 1;
    }
  }
}

/** House conventions, when the knowledge base has them. */
function readConventions(projectRoot: string, kbDir: string): string | undefined {
  const path = resolve(projectRoot, kbDir, 'conventions.md');
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

/**
 * One or two existing spec files, to show house style.
 *
 * Picked from the Suite Index rather than by globbing, so the planner sees
 * files the indexer actually understood as tests. Capped at two: exemplars are
 * the first thing the token budget drops, and a third rarely adds signal.
 */
function readExemplars(
  projectRoot: string,
  suiteDir: string,
  index: { specs: Array<{ file: string }> } | undefined,
): ExemplarFile[] {
  void suiteDir;
  if (index === undefined) return [];
  const exemplars: ExemplarFile[] = [];
  for (const spec of index.specs.slice(0, 2)) {
    const path = resolve(projectRoot, spec.file);
    if (!existsSync(path)) continue;
    exemplars.push({ path: spec.file, contents: readFileSync(path, 'utf8') });
  }
  return exemplars;
}
