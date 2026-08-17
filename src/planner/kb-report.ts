import type { AppKnowledge } from '../schemas/kb-app.js';
import type { GapReport, KbGap } from './kb-gaps.js';

/**
 * Renders gap reports for a human.
 *
 * The format is the message: a file to open and a fact to add, per line. A
 * report that said "context insufficient" would be true and useless. The
 * grounded entries are shown too — partly so a reader can confirm the checker
 * understood the spec, and partly because a list of things that already work is
 * what makes the remaining three feel finishable rather than endless.
 */

const LABEL: Record<KbGap['kind'], string> = {
  'unknown-entity': 'not described',
  'unknown-state': 'state not described',
  'unreachable-state': 'no way to reach',
  'dangling-reference': 'broken reference',
  'unresolved-need': 'no states listed',
  'unknown-page': 'page not explored',
};

export function formatGapReport(reports: GapReport[], knowledge: AppKnowledge): string {
  const lines: string[] = [];
  const total = reports.reduce((n, r) => n + r.gaps.length, 0);
  const grounded = reports.reduce((n, r) => n + r.grounded.length, 0);

  for (const report of reports) {
    if (report.gaps.length === 0 && report.grounded.length === 0) continue;
    lines.push(`${report.featureId}`);

    for (const item of report.grounded) {
      lines.push(`  ok  ${item.need}`);
      lines.push(`        -> ${item.entity}.${item.state} via ${item.via}`);
    }

    for (const gap of report.gaps) {
      lines.push(`  !!  ${gap.what}   (${LABEL[gap.kind]})`);
      lines.push(`        ${gap.reason}`);
      lines.push(`        fix: ${gap.fix}`);
      if (gap.candidates !== undefined && gap.candidates.length > 0) {
        lines.push(`        known: ${gap.candidates.join(', ')}`);
      }
    }
    lines.push('');
  }

  if (knowledge.warnings.length > 0) {
    lines.push('Knowledge base files that could not be read:');
    for (const w of knowledge.warnings) lines.push(`  ${w.file}: ${w.message}`);
    lines.push('');
  }

  lines.push(
    total === 0
      ? `All ${grounded} declared data need(s) are grounded.`
      : `${grounded} grounded, ${total} gap(s) across ${reports.length} feature(s).`,
  );

  if (total > 0 && knowledge.entities.length === 0) {
    // The most common first run: `dataNeeds` written, `kb/app/entities/` empty.
    // Without this the report reads as a list of failures rather than as the
    // to-do list it actually is.
    lines.push(
      '',
      'No entities are described yet. Each gap above is one short file —',
      'start with the ones a p0 feature needs and leave the rest.',
    );
  }
  return lines.join('\n');
}

/** Machine-readable form, for `--json` and for CI. */
export function gapSummary(reports: GapReport[]): {
  ok: boolean;
  grounded: number;
  gaps: number;
  byKind: Record<string, number>;
  features: Array<{ featureId: string; gaps: KbGap[] }>;
} {
  const byKind: Record<string, number> = {};
  let gaps = 0;
  for (const report of reports) {
    for (const gap of report.gaps) {
      byKind[gap.kind] = (byKind[gap.kind] ?? 0) + 1;
      gaps += 1;
    }
  }
  return {
    ok: gaps === 0,
    grounded: reports.reduce((n, r) => n + r.grounded.length, 0),
    gaps,
    byKind,
    features: reports
      .filter((r) => r.gaps.length > 0)
      .map((r) => ({ featureId: r.featureId, gaps: r.gaps })),
  };
}
