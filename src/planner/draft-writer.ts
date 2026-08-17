import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type { DraftEntity, DraftFeature, DraftedKb } from '../schemas/draft.js';
import type { SuiteManifest } from '../schemas/manifest.js';
import type { Resolution } from './draft.js';
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

function renderRoles(draft: DraftedKb, manifest: SuiteManifest, source: string): string {
  const getters = manifest.credentials.map((c) => c.getter);
  const notes: string[] = [];

  const roles = draft.roles.map((role) => {
    const entry: Record<string, unknown> = { id: role.id };
    if (role.description !== undefined) entry['description'] = role.description;

    const hint = role.credentialsHint ?? role.id;
    const exact = getters.find((g) => g === hint);
    const candidates = exact !== undefined ? [exact] : near(hint, getters);

    if (candidates.length === 1) {
      entry['credentials'] = candidates[0];
    } else if (candidates.length > 1) {
      // Two getters could fit and the document does not say which. Picking one
      // would be a coin flip that looks like a decision.
      entry['credentials'] = candidates[0];
      notes.push(
        `- \`${role.id}\`: more than one getter could fit — ` +
          `${candidates.map((c) => `\`${c}\``).join(', ')}. ` +
          `\`${candidates[0]}\` was used; confirm which account has the access.`,
      );
    } else {
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

/** What the CLI prints: the decisions a human is being asked to check. */
export function formatDraftSummary(
  draft: DraftedKb,
  resolutions: Resolution[],
  files: DraftFile[],
): string {
  const lines: string[] = [];

  lines.push(`Drafted ${files.length} file(s):`);
  for (const file of files) {
    lines.push(`  ${file.path}${file.diverted ? '   (existing file kept — diff these)' : ''}`);
  }

  if (draft.outOfScope.length > 0) {
    lines.push('', 'Out of scope for this suite:');
    for (const item of draft.outOfScope) lines.push(`  - ${item.what}`, `      ${item.why}`);
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

  lines.push(
    '',
    'Every spec is `status: draft`. Review, correct, then run `flint kb` to',
    'check the result against the suite.',
  );
  return lines.join('\n');
}
