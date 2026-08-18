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

  // Nothing checked is not the same as everything passing, and "All 0 declared
  // data need(s) are grounded" reads as a pass. Someone whose specs are in the
  // wrong directory would take that as confirmation and move on.
  if (reports.length === 0) {
    return [
      'No feature specs found — nothing was checked.',
      '',
      'Write one in kb/features/<id>.md with a `dataNeeds:` list, then re-run.',
      '`_`-prefixed specs are skipped by design.',
      // Reported here too: a pending credential review is a fact about the KB,
      // not about the specs, and staying silent about it because no spec exists
      // yet is how it gets forgotten.
      ...(pendingReviews(knowledge).length > 0
        ? ['', ...reviewLines(knowledge)]
        : []),
    ].join('\n');
  }

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

  // Credentials Flint guessed. Not a gap — the getter exists and every check
  // passes — which is exactly why it needs saying out loud. A role bound to the
  // wrong real account runs the whole feature as the wrong user and fails an
  // access assertion that is correct.
  if (pendingReviews(knowledge).length > 0) lines.push(...reviewLines(knowledge), '');

  lines.push(
    total === 0 && grounded === 0
      ? `${reports.length} feature(s) checked; none declares a \`dataNeeds:\` list, so there was nothing to ground.`
      : total === 0
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

function reviewLines(knowledge: AppKnowledge): string[] {
  const lines = ['Waiting on you before this runs:'];
  for (const role of pendingReviews(knowledge)) {
    lines.push(
      `  ??  ${role.id}${role.credentials !== undefined ? ` -> ${role.credentials}` : ''}`,
      `        ${role.review!}`,
    );
  }
  return lines;
}

/**
 * Roles whose credential getter Flint chose rather than read.
 *
 * The line survives until a human deletes it, and deleting it is the act of
 * confirming — so the state "somebody checked this" is recorded in the file
 * itself rather than in whoever happened to read the terminal that day.
 */
export function pendingReviews(knowledge: AppKnowledge): AppKnowledge['roles'] {
  return knowledge.roles.filter((role) => role.review !== undefined);
}

/** Machine-readable form, for `--json` and for CI. */
export function gapSummary(
  reports: GapReport[],
  knowledge?: AppKnowledge,
): {
  ok: boolean;
  grounded: number;
  gaps: number;
  byKind: Record<string, number>;
  needsReview: Array<{ id: string; credentials?: string; review: string }>;
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
    needsReview: (knowledge === undefined ? [] : pendingReviews(knowledge)).map((role) => ({
      id: role.id,
      ...(role.credentials !== undefined ? { credentials: role.credentials } : {}),
      review: role.review!,
    })),
    features: reports
      .filter((r) => r.gaps.length > 0)
      .map((r) => ({ featureId: r.featureId, gaps: r.gaps })),
  };
}
