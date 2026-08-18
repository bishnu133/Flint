import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type { DraftEntity, DraftFeature, DraftRole, DraftedKb } from '../schemas/draft.js';
import type { SuiteManifest } from '../schemas/manifest.js';
import type { Resolution } from './draft.js';
import type { NeedCheck } from './draft-check.js';
import { near } from './kb-gaps.js';

/**
 * Renders a draft knowledge base to markdown, and writes it without ever
 * destroying what a human already wrote.
 *
 * Two rules run through this file.
 *
 * **Never overwrite.** A file that exists on disk was reviewed by somebody; a
 * draft is a first guess by a model. When they collide the draft is written
 * beside the original with a `.draft.md` suffix and reported, so a human can
 * diff and merge. Silently replacing a corrected entity file with a fresh guess
 * would make the review step pointless, and would be indistinguishable from the
 * tool working.
 *
 * **Unresolved references become visible TODOs.** A `setupHint` Flint could not
 * match is written as a comment containing the model's own words, not as a
 * plausible-looking method call. `flint kb` then reports the state as
 * ungrounded, which is exactly right — nobody has said how to reach it yet.
 */

export interface DraftFile {
  /** Path relative to the project root. */
  path: string;
  contents: string;
  /** True when the intended path was taken and this is a `.draft.md` sibling. */
  diverted: boolean;
}

export interface RenderDraftOptions {
  draft: DraftedKb;
  resolutions: Resolution[];
  manifest: SuiteManifest;
  kbDir: string;
  /** Named in generated comments so a reader can find the source. */
  source: string;
  projectRoot: string;
}

export function renderDraft(options: RenderDraftOptions): DraftFile[] {
  const files: DraftFile[] = [];

  for (const feature of options.draft.features) {
    files.push(
      place(
        options,
        join(options.kbDir, 'features', `${feature.id}.md`),
        renderFeature(feature, options.source),
      ),
    );
  }

  for (const entity of options.draft.entities) {
    files.push(
      place(
        options,
        join(options.kbDir, 'app', 'entities', `${entity.entity}.md`),
        renderEntity(entity, options.resolutions, options.source),
      ),
    );
  }

  if (options.draft.roles.length > 0) {
    files.push(
      place(
        options,
        join(options.kbDir, 'app', 'roles.md'),
        renderRoles(options.draft, options.manifest, options.source),
      ),
    );
  }

  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** Divert to a `.draft.md` sibling rather than overwrite a reviewed file. */
function place(options: RenderDraftOptions, path: string, contents: string): DraftFile {
  const taken = existsSync(resolve(options.projectRoot, path));
  return taken
    ? { path: path.replace(/\.md$/, '.draft.md'), contents, diverted: true }
    : { path, contents, diverted: false };
}

export function writeDraft(projectRoot: string, files: DraftFile[]): void {
  for (const file of files) {
    const path = resolve(projectRoot, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.contents, 'utf8');
  }
}

function renderFeature(feature: DraftFeature, source: string): string {
  const frontmatter: Record<string, unknown> = {
    id: feature.id,
    title: feature.title,
    priority: feature.priority,
  };
  if (feature.tags.length > 0) frontmatter['tags'] = feature.tags;
  if (feature.pages.length > 0) frontmatter['pages'] = feature.pages;
  if (feature.acceptanceCriteria.length > 0) {
    frontmatter['acceptanceCriteria'] = feature.acceptanceCriteria;
  }
  if (feature.negativeCases.length > 0) frontmatter['negativeCases'] = feature.negativeCases;
  if (feature.dataNeeds.length > 0) frontmatter['dataNeeds'] = feature.dataNeeds;
  // Always `draft`, whatever the model thought. Marking its own output ready
  // would skip the review this whole stage exists to enable.
  frontmatter['status'] = 'draft';

  const lines = [
    '---',
    stringifyYaml(frontmatter).trimEnd(),
    '---',
    '',
    `<!-- Drafted by \`flint draft\` from ${source}. Review before use. -->`,
    '',
  ];

  if (feature.body.trim() !== '') lines.push(feature.body.trim(), '');

  if (feature.covers.length > 0) {
    lines.push(
      '## Covers',
      '',
      'Quoted from the source document, so the split can be checked without',
      're-reading it.',
      '',
      ...feature.covers.map((c) => `- ${c}`),
      '',
    );
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function renderEntity(entity: DraftEntity, resolutions: Resolution[], source: string): string {
  const states: Record<string, Record<string, string>> = {};
  const todos: string[] = [];

  for (const state of entity.states) {
    const entry: Record<string, string> = {};
    const resolution = resolutions.find(
      (r) => r.entity === entity.entity && r.state === state.name,
    );

    if (state.unreachableReason !== undefined) {
      entry['unreachable'] = state.unreachableReason;
    } else if (state.environmentNote !== undefined) {
      entry['environment'] = state.environmentNote;
    } else if (resolution?.kind === 'repository' && resolution.reference !== undefined) {
      entry['repository'] = resolution.reference;
    } else if (resolution?.kind === 'flow' && resolution.reference !== undefined) {
      entry['flow'] = resolution.reference;
    } else if (state.setupHint !== undefined) {
      // Nothing matched. Record the intent honestly and leave the state without
      // a setup path, so `flint kb` reports it rather than a later run failing
      // on a method that never existed.
      entry['unreachable'] = `TODO — no matching method found for: ${state.setupHint}`;
      todos.push(
        `- \`${state.name}\`: ${state.setupHint}` +
          (resolution !== undefined && resolution.candidates.length > 0
            ? `\n  Closest in the suite: ${resolution.candidates.map((c) => `\`${c}\``).join(', ')}`
            : ''),
      );
    }

    if (state.note !== undefined) entry['note'] = state.note;
    states[state.name] = entry;
  }

  const frontmatter: Record<string, unknown> = {};
  if (entity.aliases.length > 0) frontmatter['aliases'] = entity.aliases;
  frontmatter['states'] = states;

  const lines = [
    '---',
    stringifyYaml(frontmatter).trimEnd(),
    '---',
    '',
    `<!-- Drafted by \`flint draft\` from ${source}. Review before use. -->`,
    '',
    `# ${entity.entity}`,
    '',
  ];
  if (entity.description !== undefined) lines.push(entity.description.trim(), '');

  if (todos.length > 0) {
    lines.push(
      '## Needs a human',
      '',
      'These states have no setup path Flint could match against the suite.',
      'Either point them at a real method, or replace the `unreachable:` text',
      'with the real reason no test can reach them — both are useful answers.',
      '',
      ...todos,
      '',
    );
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * The text to match a role against the suite's credential getters.
 *
 * `credentialsHint` is supposed to be the role as the document names it —
 * "Vendor Admins". A live run produced a seventeen-word clause instead ("BAP
 * user with Vendor Admin role, not assigned to HPB Activity Vendor User
 * Managers or Partner PA Activity Vendor User Managers"), and `near` compares
 * *names*: handed a sentence it matched on incidental words and offered five
 * getters, one of them about reward partners. Five candidates where two are
 * plausible is not a shortlist, it is noise wearing a shortlist's clothes.
 *
 * So: use the hint when it reads like a name, otherwise fall back to the
 * shortest thing that does. An alias is written for exactly this purpose, and
 * the camelCase id — `vendorAdmin` — tokenises into the two words that matter.
 */
export function credentialQuery(role: DraftRole): string {
  const candidates = [role.credentialsHint, ...role.aliases, role.id].filter(
    (value): value is string => value !== undefined && value.trim() !== '',
  );
  const nameLike = candidates.filter((c) => wordCount(c) <= MAX_ROLE_HINT_WORDS);
  return nameLike[0] ?? candidates[candidates.length - 1] ?? role.id;
}

/** Where a role description stops being a name and starts being a sentence. */
const MAX_ROLE_HINT_WORDS = 6;

function wordCount(value: string): number {
  return value.split(/[^A-Za-z0-9]+/).filter((word) => word.length > 1).length;
}

function renderRoles(draft: DraftedKb, manifest: SuiteManifest, source: string): string {
  const getters = manifest.credentials.map((c) => c.getter);
  const notes: string[] = [];

  const roles = draft.roles.map((role) => {
    const entry: Record<string, unknown> = { id: role.id };
    if (role.description !== undefined) entry['description'] = role.description;

    const hint = credentialQuery(role);
    const exact = getters.find((g) => g === hint);
    const candidates = exact !== undefined ? [exact] : near(hint, getters);

    if (exact !== undefined) {
      entry['credentials'] = exact;
    } else if (candidates.length >= 1) {
      // Nothing matched by name, so this is a guess however plausible it looks.
      // It is written with a `review:` line beside it: a wrong-but-existing
      // getter passes every check Flint has and then runs the whole feature as
      // the wrong user, failing an access assertion that is actually correct.
      // The marker is what turns that into a question somebody gets asked.
      entry['credentials'] = candidates[0];
      entry['review'] =
        candidates.length > 1
          ? `more than one getter could fit "${hint}" — ${candidates.join(', ')}. Confirm which account has the access, then delete this line.`
          : `matched "${hint}" by name, not by fact. Confirm this account has the access, then delete this line.`;
      notes.push(
        `- \`${role.id}\`: ${candidates.length > 1 ? 'more than one getter could fit' : 'matched by name only'} — ` +
          `${candidates.map((c) => `\`${c}\``).join(', ')}. ` +
          `\`${candidates[0]}\` was used; confirm which account has the access.`,
      );
    } else {
      entry['review'] = `no credential getter matched "${hint}". Add one, or name the right getter here.`;
      notes.push(`- \`${role.id}\`: no credential getter matched "${hint}". Add one.`);
    }

    if (role.aliases.length > 0) entry['aliases'] = role.aliases;
    return entry;
  });

  const lines = [
    '---',
    stringifyYaml({ roles }).trimEnd(),
    '---',
    '',
    `<!-- Drafted by \`flint draft\` from ${source}. Review before use. -->`,
    '',
    '# Roles',
    '',
    '`credentials` names an exported getter in your own codebase. `flint kb`',
    'checks it exists, so a rename is caught here rather than in a failing run.',
    '',
  ];
  if (notes.length > 0) lines.push('## Needs a human', '', ...notes, '');
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * Specs already on disk that were drafted from this same document.
 *
 * The never-overwrite rule compares *paths*, and a model asked twice about one
 * card does not produce the same id twice: a live run left
 * `vendor-admin-facilitator-view`, `vendor-admin-facilitators-view` and
 * `vendor-admin-view-facilitators` side by side, one card reported as three
 * features with three sets of gaps. No file was damaged and nothing failed —
 * the gap report simply tripled, and the operator had no way to tell which
 * entries were live.
 *
 * The generated comment names the source, so the earlier attempts can be found
 * exactly rather than guessed at from similar-looking ids.
 */
export function priorDraftsFrom(projectRoot: string, kbDir: string, source: string): string[] {
  const dir = resolve(projectRoot, kbDir, 'features');
  if (!existsSync(dir)) return [];
  const marker = `Drafted by \`flint draft\` from ${source}`;
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md') && !name.endsWith('.draft.md'))
    .filter((name) => readFileSync(join(dir, name), 'utf8').includes(marker))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => join(kbDir, 'features', name));
}

/** What the CLI prints: the decisions a human is being asked to check. */
export function formatDraftSummary(
  draft: DraftedKb,
  resolutions: Resolution[],
  files: DraftFile[],
  needs: NeedCheck[],
  priorDrafts: string[] = [],
): string {
  const lines: string[] = [];

  lines.push(`Drafted ${files.length} file(s):`);
  for (const file of files) {
    lines.push(`  ${file.path}${file.diverted ? '   (existing file kept — diff these)' : ''}`);
    // What each feature claims to cover, inline. Without it the summary shows
    // a file count and nothing about the split, so a run that collapsed five
    // requirements into one feature reads identically to one that dropped four.
    const feature = draft.features.find((f) => file.path.endsWith(`/${f.id}.md`));
    if (feature !== undefined && feature.covers.length > 0) {
      lines.push(`      covers: ${feature.covers.join('; ')}`);
    }
  }

  if (draft.outOfScope.length > 0) {
    lines.push('', 'Out of scope for this suite:');
    for (const item of draft.outOfScope) lines.push(`  - ${item.what}`, `      ${item.why}`);
  }

  // Whether the draft grounds itself, reported here rather than left for
  // `flint kb` to discover. A run that wrote four good-looking files and scores
  // zero should say so while the operator is still looking at it.
  const stranded = needs.filter((n) => n.status !== 'grounded');
  if (stranded.length > 0) {
    lines.push('', 'Preconditions that will not ground:');
    for (const check of stranded) {
      lines.push(`  - ${check.featureId}: ${check.need}`);
      if (check.status === 'no-state') {
        lines.push(
          `      \`${check.entity}\` matches, but none of its state names read inside that sentence.`,
          `      states: ${check.known.join(', ')}`,
        );
      } else {
        lines.push(
          '      no entity or role name reads inside that sentence.',
          `      known: ${check.known.join(', ') || 'nothing yet'}`,
        );
      }
    }
    lines.push(
      '',
      '  `flint kb` matches these by words: the entity and state a need asks for',
      '  have to be readable inside the need itself. Shorten the state name, or',
      '  reword the need to use it — either fixes the pair.',
    );
  }

  const unresolved = resolutions.filter((r) => r.kind === 'unresolved');
  if (unresolved.length > 0) {
    lines.push('', 'Setup paths with no matching method:');
    for (const item of unresolved) {
      lines.push(`  - ${item.entity}.${item.state}: ${item.hint}`);
      if (item.candidates.length > 0) lines.push(`      closest: ${item.candidates.join(', ')}`);
    }
  }

  if (draft.openQuestions.length > 0) {
    lines.push('', 'Open questions:');
    for (const question of draft.openQuestions) lines.push(`  ? ${question}`);
  }

  if (priorDrafts.length > 0) {
    lines.push(
      '',
      'This document was already drafted into:',
      ...priorDrafts.map((path) => `  ${path}`),
      '',
      '  Those are left alone, and `flint kb` reads them as live specs — so one',
      '  card will be reported as several features until you delete the ones you',
      '  do not want.',
    );
  }

  lines.push(
    '',
    'Every spec is `status: draft`. Review, correct, then run `flint kb` to',
    'check the result against the suite.',
  );
  return lines.join('\n');
}
