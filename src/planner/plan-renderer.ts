import type { TestCase, TestPlan } from '../schemas/test-plan.js';
import type { FeatureSpec } from './feature-spec.js';
import type { DuplicateDecision } from './plan-validator.js';

/**
 * `<feature>.plan.md` — the human review surface.
 *
 * A plan is meant to be read and corrected *before* a line of TypeScript
 * exists; that is the cheapest place to catch a misunderstanding. So this leads
 * with the two things a reviewer needs to judge quickly — which acceptance
 * criteria are actually covered, and what the planner was unsure about — and
 * only then lists the cases.
 */

export interface RenderPlanOptions {
  plan: TestPlan;
  spec: FeatureSpec;
  forcedDuplicates?: DuplicateDecision[];
  /** Context sections dropped to fit the budget; worth disclosing. */
  droppedContext?: string[];
}

export function renderPlan(options: RenderPlanOptions): string {
  const { plan, spec } = options;
  const lines: string[] = [
    `# Test plan — ${spec.frontmatter.title}`,
    '',
    `Feature \`${plan.featureId}\` · ${plan.cases.length} case(s) · generated ${plan.generatedAt}`,
    `Screen Model version \`${plan.screenModelVersion}\``,
    '',
    ...renderSummary(plan),
    '',
    ...renderCoverage(plan, spec),
  ];

  if (plan.openQuestions !== undefined && plan.openQuestions.length > 0) {
    lines.push('', '## Open questions', '', '_The planner asked rather than guessing._', '');
    for (const question of plan.openQuestions) lines.push(`- [ ] ${question}`);
  }

  const forced = options.forcedDuplicates ?? [];
  if (forced.length > 0) {
    lines.push('', '## Forced to skipped-duplicate', '');
    lines.push("_Deterministic post-check, not the model's judgement._", '');
    for (const decision of forced) {
      lines.push(
        `- \`${decision.caseId}\` duplicates "${decision.duplicateOf}" ` +
          `(${(decision.similarity * 100).toFixed(0)}% title similarity)`,
      );
    }
  }

  const dropped = options.droppedContext ?? [];
  if (dropped.length > 0) {
    lines.push('', '## Context truncated', '');
    lines.push(
      '_These were dropped to fit the token budget. If the plan looks thin, raise_',
      '_`tokenBudgets.plan` in flint.config.ts and re-run._',
      '',
    );
    for (const section of dropped) lines.push(`- ${section}`);
  }

  lines.push('', '## Cases', '');
  for (const testCase of plan.cases) lines.push(...renderCase(testCase), '');

  return `${lines.join('\n').trimEnd()}\n`;
}

function renderSummary(plan: TestPlan): string[] {
  const counts = new Map<string, number>();
  for (const testCase of plan.cases) {
    counts.set(testCase.status, (counts.get(testCase.status) ?? 0) + 1);
  }
  const needsSetup = plan.cases.filter(
    (c) => c.prerequisites !== undefined && c.prerequisites.length > 0,
  ).length;

  const parts = [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([status, n]) => `${n} ${status}`);
  if (needsSetup > 0) parts.push(`${needsSetup} needing setup`);
  return ['## Summary', '', parts.length === 0 ? '(no cases)' : parts.join(' · ')];
}

/**
 * Acceptance-criterion checklist.
 *
 * The Phase 3 exit criterion is that a plan covers every acceptance criterion,
 * so this is the artefact that proves it — and an uncovered criterion is called
 * out rather than left for a reviewer to notice by counting.
 */
function renderCoverage(plan: TestPlan, spec: FeatureSpec): string[] {
  const criteria = spec.frontmatter.acceptanceCriteria ?? [];
  if (criteria.length === 0) {
    return ['## Acceptance coverage', '', '_The spec declares no acceptance criteria._'];
  }

  const covered = new Map<string, string[]>();
  for (const testCase of plan.cases) {
    for (const ref of testCase.acceptanceRefs ?? []) {
      covered.set(ref, [...(covered.get(ref) ?? []), testCase.id]);
    }
  }

  const lines = ['## Acceptance coverage', ''];
  let uncovered = 0;
  criteria.forEach((criterion, i) => {
    const id = `AC${i + 1}`;
    const cases = covered.get(id) ?? [];
    if (cases.length === 0) uncovered += 1;
    const mark = cases.length > 0 ? 'x' : ' ';
    const by = cases.length > 0 ? ` — ${cases.map((c) => `\`${c}\``).join(', ')}` : '';
    lines.push(`- [${mark}] **${id}** ${criterion}${by}`);
  });

  if (uncovered > 0) {
    lines.push(
      '',
      `> **${uncovered} acceptance criterion/criteria have no case.** Either the spec`,
      '> asks for something the app does not expose, or the plan is incomplete.',
    );
  }
  return lines;
}

function renderCase(testCase: TestCase): string[] {
  const lines = [`### \`${testCase.id}\` — ${testCase.title}`, ''];

  const meta = [`**${testCase.status}**`, testCase.priority];
  if (testCase.tags.length > 0) meta.push(testCase.tags.join(' '));
  lines.push(meta.join(' · '), '');

  if (testCase.status === 'blocked') {
    lines.push(`> **Blocked:** ${testCase.blockedReason ?? '(no reason given)'}`, '');
  }
  if (testCase.duplicateOf !== undefined) {
    lines.push(`> Targets existing test: "${testCase.duplicateOf}"`, '');
  }
  if (testCase.acceptanceRefs !== undefined && testCase.acceptanceRefs.length > 0) {
    lines.push(`Covers: ${testCase.acceptanceRefs.join(', ')}`, '');
  }

  const prerequisites = testCase.prerequisites ?? [];
  if (prerequisites.length > 0) {
    lines.push('**Needs before it can pass:**', '');
    for (const prerequisite of prerequisites) {
      const key = prerequisite.key === undefined ? '' : ` (\`${prerequisite.key}\`)`;
      lines.push(`- _${prerequisite.kind}_${key}: ${prerequisite.description}`);
    }
    lines.push('');
  }

  if (testCase.steps.length === 0) {
    lines.push('_No steps._');
    return lines;
  }
  lines.push('| # | action | element | detail |', '| - | ------ | ------- | ------ |');
  testCase.steps.forEach((step, i) => {
    const detail =
      step.assertion !== undefined
        ? `${step.assertion.kind} = ${JSON.stringify(step.assertion.expected)}`
        : (step.value ?? step.note ?? '');
    lines.push(`| ${i + 1} | ${step.action} | ${step.elementRef ?? ''} | ${escapeCell(detail)} |`);
  });
  return lines;
}

/** Pipes would break the markdown table. */
function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
