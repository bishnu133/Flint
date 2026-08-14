import { estimateCost, formatUsd, priceOf } from './pricing.js';
import { totalUsage, type RecordedCall } from './recorder.js';

/**
 * The V1 benchmark: the numbers V2 has to beat.
 *
 * The master plan is explicit that agentic upgrades must **prove** improvement
 * rather than vibe it, which only works if the V1 baseline is recorded before
 * anyone starts building V2. That is this module's whole reason to exist.
 *
 * Every metric here is either measured or explicitly absent. There is no
 * default-to-zero and no default-to-100%: `undefined` renders as `not measured`,
 * because a benchmark that quietly reports 0% for something it never ran is
 * worse than one that admits the gap — the first is a false regression, the
 * second is a to-do.
 */

export interface FeatureMetrics {
  featureId: string;
  cases: number;
  /** Tests that will actually run, after duplicates and degradation. */
  liveTests: number;
  degraded: number;
  /** True when this feature's emitted code drew no compile-gate errors. */
  compiled: boolean;
  inputTokens: number;
  outputTokens: number;
  /** Undefined when the model has no price in the table. */
  costUsd?: number;
  models: string[];
}

export interface StageTiming {
  stage: string;
  ms: number;
}

export interface BenchReport {
  /** ISO timestamp — a baseline is only meaningful with a date on it. */
  ranAt: string;
  baseUrl: string;
  features: FeatureMetrics[];
  stages: StageTiming[];
  /** Features whose emitted code compiled, over features emitted. */
  compileRate: number;
  /** Pass rate of the first verify run, before any repair. */
  firstRunPass?: number;
  /** Pass rate after the repair loop. Absent when repair did not run. */
  postRepairPass?: number;
  /** Fraction of stored top selectors that still resolve. Absent unless measured. */
  selectorResolveRate?: number;
  totals: {
    inputTokens: number;
    outputTokens: number;
    costUsd?: number;
    wallMs: number;
  };
  /** Models with no entry in the pricing table, if any. */
  unpricedModels: string[];
}

export interface FeatureInput {
  featureId: string;
  cases: number;
  liveTests: number;
  degraded: number;
  compiled: boolean;
  calls: readonly RecordedCall[];
}

export interface AssembleOptions {
  baseUrl: string;
  features: FeatureInput[];
  stages: StageTiming[];
  wallMs: number;
  firstRunPass?: number;
  postRepairPass?: number;
  selectorResolveRate?: number;
  ranAt?: string;
}

export function assembleBench(options: AssembleOptions): BenchReport {
  const unpriced = new Set<string>();
  const features: FeatureMetrics[] = options.features.map((feature) => {
    const usage = totalUsage(feature.calls);
    let cost: number | undefined = 0;
    for (const model of usage.models) {
      const forModel = feature.calls.filter((c) => c.model === model);
      const estimate = estimateCost(
        model,
        forModel.reduce((s, c) => s + c.inputTokens, 0),
        forModel.reduce((s, c) => s + c.outputTokens, 0),
      );
      if (!estimate.priced) {
        unpriced.add(model);
        cost = undefined;
        continue;
      }
      if (cost !== undefined) cost += estimate.usd;
    }
    return {
      featureId: feature.featureId,
      cases: feature.cases,
      liveTests: feature.liveTests,
      degraded: feature.degraded,
      compiled: feature.compiled,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      ...(cost !== undefined ? { costUsd: cost } : {}),
      models: usage.models,
    };
  });

  const totalIn = features.reduce((s, f) => s + f.inputTokens, 0);
  const totalOut = features.reduce((s, f) => s + f.outputTokens, 0);
  // One unpriced model makes the total unknown, not partial. A total that
  // silently omits a model reads as complete and is not.
  const totalCost = features.every((f) => f.costUsd !== undefined)
    ? features.reduce((s, f) => s + (f.costUsd ?? 0), 0)
    : undefined;

  return {
    ranAt: options.ranAt ?? new Date().toISOString(),
    baseUrl: options.baseUrl,
    features: [...features].sort((a, b) => a.featureId.localeCompare(b.featureId)),
    stages: options.stages,
    compileRate:
      features.length === 0 ? 0 : features.filter((f) => f.compiled).length / features.length,
    ...(options.firstRunPass !== undefined ? { firstRunPass: options.firstRunPass } : {}),
    ...(options.postRepairPass !== undefined ? { postRepairPass: options.postRepairPass } : {}),
    ...(options.selectorResolveRate !== undefined
      ? { selectorResolveRate: options.selectorResolveRate }
      : {}),
    totals: {
      inputTokens: totalIn,
      outputTokens: totalOut,
      ...(totalCost !== undefined ? { costUsd: totalCost } : {}),
      wallMs: options.wallMs,
    },
    unpricedModels: [...unpriced].sort(),
  };
}

/** `0.917` -> `91.7%`; absent -> `not measured`. */
export function pct(value: number | undefined): string {
  return value === undefined ? 'not measured' : `${(value * 100).toFixed(1)}%`;
}

function duration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * The baseline document, as markdown.
 *
 * Written to be committed and diffed: stable ordering, no incidental values in
 * the headline table, and every "not measured" spelled out so a later run that
 * fills one in reads as new information rather than a regression.
 */
export function formatBaseline(report: BenchReport): string {
  const lines: string[] = [];
  lines.push('# Flint V1 benchmark baseline', '');
  lines.push(`Run at **${report.ranAt}** against \`${report.baseUrl}\`.`, '');
  lines.push(
    'V2 has to beat these numbers, not feel better than them. Anything marked',
    '_not measured_ was not run — it is a gap in this baseline, not a zero.',
    '',
  );

  lines.push('## Headline', '');
  lines.push('| Metric | Value |', '| --- | --- |');
  lines.push(`| Compile rate | ${pct(report.compileRate)} |`);
  lines.push(`| First-run pass | ${pct(report.firstRunPass)} |`);
  lines.push(`| Post-repair pass | ${pct(report.postRepairPass)} |`);
  lines.push(`| Selector re-resolve rate | ${pct(report.selectorResolveRate)} |`);
  lines.push(
    `| Cost per feature | ${
      report.totals.costUsd === undefined || report.features.length === 0
        ? 'not priced'
        : formatUsd(report.totals.costUsd / report.features.length)
    } |`,
  );
  lines.push(`| Wall time | ${duration(report.totals.wallMs)} |`);
  lines.push('');

  lines.push('## Per feature', '');
  lines.push(
    '| Feature | Cases | Live tests | Degraded | Compiled | Tokens in | Tokens out | Cost |',
    '| --- | ---: | ---: | ---: | :---: | ---: | ---: | ---: |',
  );
  for (const feature of report.features) {
    lines.push(
      `| ${feature.featureId} | ${feature.cases} | ${feature.liveTests} | ${feature.degraded} | ` +
        `${feature.compiled ? 'yes' : 'no'} | ${feature.inputTokens} | ${feature.outputTokens} | ` +
        `${feature.costUsd === undefined ? 'unpriced' : formatUsd(feature.costUsd)} |`,
    );
  }
  lines.push('');

  lines.push('## Wall time per stage', '');
  lines.push('| Stage | Time |', '| --- | ---: |');
  for (const stage of report.stages) lines.push(`| ${stage.stage} | ${duration(stage.ms)} |`);
  lines.push('');

  const models = [...new Set(report.features.flatMap((f) => f.models))].sort();
  if (models.length > 0) {
    lines.push('## Pricing used', '');
    lines.push(
      '| Model | $/MTok in | $/MTok out | As of | Note |',
      '| --- | ---: | ---: | --- | --- |',
    );
    for (const model of models) {
      const price = priceOf(model);
      lines.push(
        price === undefined
          ? `| ${model} | — | — | — | not in the pricing table |`
          : `| ${model} | ${price.inputPerMTok.toFixed(2)} | ${price.outputPerMTok.toFixed(2)} | ${price.asOf} | ${price.note ?? ''} |`,
      );
    }
    lines.push('');
    lines.push(
      'Costs are estimates from published list prices on the date shown, not billed amounts.',
      '',
    );
  }

  if (report.unpricedModels.length > 0) {
    lines.push(
      `**${report.unpricedModels.length} model(s) had no price** (${report.unpricedModels.join(', ')}), ` +
        'so totals that include them are omitted rather than under-counted.',
      '',
    );
  }

  return lines.join('\n');
}
