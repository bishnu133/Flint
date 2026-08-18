import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { Command } from 'commander';
import { loadConfig } from '../../config/load.js';
import { createLogger } from '../../shared/logger.js';
import { ConfigError } from '../../shared/errors.js';
import { classify, withMarker } from '../../indexer/managed.js';
import { scanManifest } from '../../indexer/manifest-scan.js';
import { tryReadManifest } from '../../indexer/manifest-store.js';
import { modelPath, readModel } from '../../explorer/screen-model-store.js';
import { planPath, readAllPlans, tryReadPlan } from '../../planner/store.js';
import { readFeatureSpec } from '../../planner/feature-spec.js';
import { readAppKnowledge } from '../../planner/kb-app.js';
import { checkKbGaps } from '../../planner/kb-gaps.js';
import { buildSuite } from '../../generator/bubblegum/suite.js';
import { renderSuite, type RenderedFile } from '../../generator/bubblegum/render.js';
import type { TestPlan } from '../../schemas/test-plan.js';

/**
 * `flint bubblegum [feature]` — emit a Bubblegum suite from a TestPlan (B3).
 *
 * ## Why this is its own command
 *
 * It belongs inside `flint generate`, selected by `config.dialect`. It is not
 * there because `generate.ts` is a completed Phase 4 file and CLAUDE.md rule 2
 * says a change to one stops and asks rather than proceeds. The Phase 4
 * `Dialect` interface is `emitPageObject(PageObjectSpec)` + `emitSpec(...)`, all
 * locators and verified selectors, and this dialect has none of those — so the
 * merge is not a one-line branch either. Recorded in PHASE_NOTES for approval;
 * until then the seam is a separate command rather than a quiet edit to frozen
 * code.
 *
 * ## What it will not do
 *
 * Overwrite a file somebody edited. Generated files carry the same managed
 * marker as every other Flint output, and an edited one is left alone with the
 * new version written beside it — because a Bubblegum flow is prose somebody
 * will have tuned by hand, and a regeneration that silently discarded that
 * tuning would be worse than one that failed.
 */
export function registerBubblegum(program: Command): void {
  program
    .command('bubblegum')
    .description('Emit a Bubblegum suite (flows, data, tests) from a plan')
    .argument('[feature]', 'feature id; omitted, every plan in .flint/plans')
    .option('-d, --dir <dir>', 'project directory', '.')
    .option('--dry-run', 'print what would be written without writing it', false)
    .option('--print', 'print the generated files to the terminal', false)
    .option('-v, --verbose', 'verbose logging', false)
    .action(async (feature: string | undefined, opts: BubblegumOptions) => {
      await runBubblegum(feature, opts);
    });
}

interface BubblegumOptions {
  dir: string;
  dryRun: boolean;
  print: boolean;
  verbose: boolean;
}

async function runBubblegum(feature: string | undefined, opts: BubblegumOptions): Promise<void> {
  const projectRoot = resolve(process.cwd(), opts.dir);
  const logger = createLogger({ verbose: opts.verbose });
  const { config } = await loadConfig(projectRoot);

  const plans = readPlans(projectRoot, feature);
  if (plans.length === 0) {
    throw new ConfigError(
      feature === undefined
        ? 'No plans found in .flint/plans.'
        : `No plan for feature "${feature}".`,
      { hint: 'Run `flint plan <feature>` first.' },
    );
  }

  const model = (() => {
    try {
      return readModel(modelPath(projectRoot));
    } catch {
      throw new ConfigError('No Screen Model — this dialect names elements by their labels.', {
        hint: 'Run `flint explore` first.',
      });
    }
  })();

  const manifest =
    tryReadManifest(projectRoot) ??
    scanManifest({ projectRoot, suiteDir: config.suiteDir, logger });
  const knowledge = readAppKnowledge(projectRoot, config.kbDir);

  const written: string[] = [];
  const diverted: string[] = [];

  for (const plan of plans) {
    const spec = readFeatureSpec(projectRoot, config.kbDir, plan.featureId);
    // The getters the feature's roles grounded to, from the same check the
    // operator already read. Re-deriving them here could reach a different
    // answer than the gap report they approved.
    const grounded = checkKbGaps({ spec, knowledge, manifest, kbDir: config.kbDir }).grounded;
    const credentialGetters = grounded
      .filter((item) => item.entity === 'role')
      .map((item) => item.via);

    const suite = buildSuite({
      plan,
      model,
      manifest,
      title: spec.frontmatter.title ?? plan.featureId,
      credentialGetters,
    });

    for (const file of renderSuite(suite)) {
      const target = join(config.suiteDir, file.path);
      const outcome = place(projectRoot, target, file);
      if (opts.print) {
        console.log(`\n${'='.repeat(72)}\n${outcome.path}\n${'='.repeat(72)}`);
        console.log(outcome.contents);
      }
      if (!opts.dryRun) writeFile(projectRoot, outcome.path, outcome.contents);
      (outcome.diverted ? diverted : written).push(outcome.path);
    }

    console.log(summarise(suite, plan));
  }

  console.log(`\n${opts.dryRun ? 'Would write' : 'Wrote'} ${written.length} file(s):`);
  for (const path of written) console.log(`  ${path}`);
  if (diverted.length > 0) {
    console.log('\nLeft your edits alone, wrote beside them:');
    for (const path of diverted) console.log(`  ${path}`);
    console.log('  Diff these, keep what you want, and delete the extra file.');
  }
  console.log(
    `\nNothing has been run against the app yet — a Bubblegum phrase with a typo is\n` +
      `valid TypeScript, so the sentences are unchecked until \`preflight\` lands.`,
  );
  if (opts.dryRun) {
    console.log(`\n(--dry-run: nothing written into ${relative(process.cwd(), projectRoot) || '.'}.)`);
  }
}

function readPlans(projectRoot: string, feature: string | undefined): TestPlan[] {
  if (feature === undefined) return readAllPlans(projectRoot);
  const plan = tryReadPlan(planPath(projectRoot, feature));
  return plan === undefined ? [] : [plan];
}

/**
 * Where this file goes, given what is already there.
 *
 * A file Flint wrote and nobody touched is replaced. One somebody edited is left
 * exactly as it is and the new version lands beside it — the flows in this
 * dialect are prose, and prose is the kind of thing people tune by hand.
 */
function place(
  projectRoot: string,
  path: string,
  file: RenderedFile,
): { path: string; contents: string; diverted: boolean } {
  const contents = withMarker(file.contents);
  const absolute = resolve(projectRoot, path);
  if (!existsSync(absolute)) return { path, contents, diverted: false };

  const status = classify(readFileSync(absolute, 'utf8')).status;
  if (status === 'managed') return { path, contents, diverted: false };
  return { path: path.replace(/(\.[cm]?tsx?)$/, '.flint$1'), contents, diverted: true };
}

function writeFile(projectRoot: string, path: string, contents: string): void {
  const absolute = resolve(projectRoot, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents, 'utf8');
}

function summarise(suite: ReturnType<typeof buildSuite>, plan: TestPlan): string {
  const lines = [`\n${plan.featureId} — ${suite.tests.length} case(s)`];
  for (const test of suite.tests) {
    const mark =
      test.mode.kind === 'live' ? 'ok  ' : test.mode.kind === 'skip' ? '..  ' : '!!  ';
    lines.push(`  ${mark}${test.caseId}`);
    if (test.mode.kind !== 'live') lines.push(`        ${test.mode.reason}`);
  }
  return lines.join('\n');
}
