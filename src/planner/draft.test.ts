import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { FakeProvider } from '../llm/fake.js';
import type { SuiteManifest } from '../schemas/manifest.js';
import type { DraftedKb } from '../schemas/draft.js';
import { draftKnowledgeBase, resolveSetup } from './draft.js';
import { formatDraftSummary, renderDraft, writeDraft } from './draft-writer.js';
import { readAppKnowledge, splitFrontmatter } from './kb-app.js';

/**
 * The contract this stage has to keep: the model says what needs to happen, and
 * Flint decides what it is called. A drafted reference either points at code
 * that exists or is visibly unresolved — never a plausible-looking method that
 * was never written.
 */

let root: string;

const MANIFEST: SuiteManifest = {
  version: 1,
  generatedAt: '2026-08-17T00:00:00.000Z',
  suiteDir: 'e2e',
  flows: [
    {
      id: 'badge-creation.createBadge',
      file: 'flows/badge-creation.flow.ts',
      exportName: 'createBadge',
      domain: 'badge-creation',
      kind: 'create',
      summary: 'Creates a badge.',
      params: [],
      returns: 'Promise<void>',
      phrases: [],
      usedBy: [],
    },
  ],
  data: [],
  helpers: [],
  credentials: [
    { getter: 'getBAPCusCareCredentials', file: 'packages/data/BAP.ts', role: 'BAP Cus Care' },
    { getter: 'getCustomerSupportLevel1', file: 'packages/data/BAP.ts', role: 'Customer support' },
  ],
  repositories: [
    {
      className: 'UserRepository',
      file: 'packages/utilities/repository/UserRepository.ts',
      methods: ['deleteUser', 'getInstance', 'updateGAQ'],
    },
    {
      className: 'ActivityRepository',
      file: 'packages/utilities/repository/ActivityRepository.ts',
      methods: ['deleteMVPA', 'getInstance'],
    },
  ],
  warnings: [],
};

const DRAFT: DraftedKb = {
  features: [
    {
      id: 'unfit-mvpa-column',
      title: 'Activity Data shows an Unfit MVPA column',
      priority: 'p0',
      tags: ['customer-care'],
      pages: ['/customer-care'],
      acceptanceCriteria: ['The Unfit MVPA column appears after the MVPA column'],
      negativeCases: [],
      dataNeeds: ['a BAP user with the customer care role'],
      body: 'From HPBPPH-17169.',
      covers: ['AC1'],
    },
  ],
  entities: [
    {
      entity: 'gaq',
      aliases: ['fitness status'],
      description: 'Get Active Questionnaire.',
      states: [
        { name: 'unfit', setupHint: 'UserRepository.updateGAQ with value 3', note: 'value 3' },
        {
          name: 'never-answered',
          unreachableReason: 'only set by the mobile app on first launch',
        },
      ],
    },
    {
      entity: 'mvpa-data',
      aliases: [],
      states: [{ name: 'synced', setupHint: 'insert MVPA minutes for the date' }],
    },
  ],
  roles: [
    {
      id: 'customerCare',
      description: 'BAP customer support.',
      aliases: ['customer care'],
      credentialsHint: 'customer support',
    },
  ],
  outOfScope: [
    { what: 'AC6-AC9 (H365 Activity Dashboard)', why: 'mobile app; this suite drives the web portal' },
  ],
  openQuestions: ['Which credential account can open the Activity Data tab?'],
};

function fakeProviderReturning(draft: DraftedKb): FakeProvider {
  return new FakeProvider({ responder: () => ({ text: JSON.stringify(draft) }) });
}

const draftIt = () =>
  draftKnowledgeBase({
    document: '# HPBPPH-17169\nSome acceptance criteria.',
    manifest: MANIFEST,
    provider: fakeProviderReturning(DRAFT),
    modelId: 'claude-sonnet-5',
  });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'flint-draft-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resolveSetup — the model proposes, Flint disposes', () => {
  it('matches a hint that names a real method', () => {
    const r = resolveSetup(
      'gaq',
      { name: 'unfit', setupHint: 'UserRepository.updateGAQ with value 3' },
      MANIFEST,
    );
    expect(r.kind).toBe('repository');
    expect(r.reference).toBe('UserRepository.updateGAQ');
  });

  it('matches a hint that names a real flow', () => {
    const r = resolveSetup(
      'badge',
      { name: 'live', setupHint: 'run badge-creation.createBadge' },
      MANIFEST,
    );
    expect(r.kind).toBe('flow');
    expect(r.reference).toBe('badge-creation.createBadge');
  });

  it('refuses to pick when the hint is prose that merely resembles a method', () => {
    // The whole point. `UserRepository.setGAQStatus` looks exactly as
    // convincing as the method that exists, so a near miss must stay a near
    // miss rather than being promoted to fact.
    const r = resolveSetup(
      'gaq',
      { name: 'unfit', setupHint: 'call UserRepository.setGAQStatus' },
      MANIFEST,
    );
    expect(r.kind).toBe('unresolved');
    expect(r.reference).toBeUndefined();
    expect(r.candidates).toContain('UserRepository.updateGAQ');
  });

  it('leaves a genuinely unknown setup unresolved with no candidates', () => {
    const r = resolveSetup(
      'mvpa-data',
      { name: 'synced', setupHint: 'insert MVPA minutes for the date' },
      MANIFEST,
    );
    expect(r.kind).toBe('unresolved');
    expect(r.reference).toBeUndefined();
  });

  it('does not match a method name embedded in a longer identifier', () => {
    const r = resolveSetup(
      'x',
      { name: 'y', setupHint: 'call UserRepository.updateGAQStatus' },
      MANIFEST,
    );
    expect(r.kind).toBe('unresolved');
  });
});

describe('draftKnowledgeBase', () => {
  it('resolves every state that carries a hint', async () => {
    const result = await draftIt();
    expect(result.resolutions.map((r) => `${r.state}:${r.kind}`)).toEqual([
      'unfit:repository',
      'synced:unresolved',
    ]);
  });

  it('does not resolve a state declared unreachable', async () => {
    const result = await draftIt();
    expect(result.resolutions.find((r) => r.state === 'never-answered')).toBeUndefined();
  });
});

describe('renderDraft — the files a human reviews', () => {
  const render = () =>
    renderDraft({
      draft: DRAFT,
      resolutions: [
        {
          entity: 'gaq',
          state: 'unfit',
          hint: 'UserRepository.updateGAQ with value 3',
          reference: 'UserRepository.updateGAQ',
          kind: 'repository',
          candidates: [],
        },
        {
          entity: 'mvpa-data',
          state: 'synced',
          hint: 'insert MVPA minutes for the date',
          kind: 'unresolved',
          candidates: ['ActivityRepository.deleteMVPA'],
        },
      ],
      manifest: MANIFEST,
      kbDir: 'kb',
      source: 'HPBPPH-17169.md',
      projectRoot: root,
    });

  it('writes a spec, an entity file per entity, and roles', () => {
    expect(render().map((f) => f.path)).toEqual([
      'kb/app/entities/gaq.md',
      'kb/app/entities/mvpa-data.md',
      'kb/app/roles.md',
      'kb/features/unfit-mvpa-column.md',
    ]);
  });

  it('forces status: draft whatever the model thought', () => {
    // Marking its own output ready would skip the review this stage exists for.
    const spec = render().find((f) => f.path.endsWith('unfit-mvpa-column.md'))!;
    const fm = parseYaml(splitFrontmatter(spec.contents).frontmatter!) as Record<string, unknown>;
    expect(fm['status']).toBe('draft');
  });

  it('writes a resolved reference as a real setup path', () => {
    const gaq = render().find((f) => f.path.endsWith('gaq.md'))!;
    const fm = parseYaml(splitFrontmatter(gaq.contents).frontmatter!) as {
      states: Record<string, Record<string, string>>;
    };
    expect(fm.states['unfit']!['repository']).toBe('UserRepository.updateGAQ');
  });

  it('writes an unresolved hint as a TODO, never as a plausible method', () => {
    const mvpa = render().find((f) => f.path.endsWith('mvpa-data.md'))!;
    const fm = parseYaml(splitFrontmatter(mvpa.contents).frontmatter!) as {
      states: Record<string, Record<string, string>>;
    };
    expect(fm.states['synced']!['unreachable']).toMatch(/^TODO/);
    expect(fm.states['synced']!['repository']).toBeUndefined();
    expect(mvpa.contents).toContain('Needs a human');
    expect(mvpa.contents).toContain('ActivityRepository.deleteMVPA');
  });

  it('keeps a documented dead end as the reason, not a TODO', () => {
    const gaq = render().find((f) => f.path.endsWith('gaq.md'))!;
    const fm = parseYaml(splitFrontmatter(gaq.contents).frontmatter!) as {
      states: Record<string, Record<string, string>>;
    };
    expect(fm.states['never-answered']!['unreachable']).toBe(
      'only set by the mobile app on first launch',
    );
  });

  it('flags an ambiguous role rather than quietly choosing', () => {
    // Two getters could fit "customer support". Picking one silently is a coin
    // flip that reads as a decision.
    const roles = render().find((f) => f.path.endsWith('roles.md'))!;
    expect(roles.contents).toContain('Needs a human');
    expect(roles.contents).toContain('more than one getter could fit');
  });

  it('names the source document in every file', () => {
    for (const file of render()) expect(file.contents).toContain('HPBPPH-17169.md');
  });
});

describe('never overwriting a reviewed file', () => {
  it('diverts to a .draft.md sibling when the path is taken', () => {
    // A file on disk was reviewed by somebody; a draft is a first guess.
    // Replacing the first with the second would make review pointless and look
    // exactly like the tool working.
    const path = join(root, 'kb', 'app', 'entities', 'gaq.md');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '---\nstates: {}\n---\n# Hand written, do not clobber\n', 'utf8');

    const files = renderDraft({
      draft: DRAFT,
      resolutions: [],
      manifest: MANIFEST,
      kbDir: 'kb',
      source: 'card.md',
      projectRoot: root,
    });
    const gaq = files.find((f) => f.path.includes('gaq'))!;
    expect(gaq.path).toBe('kb/app/entities/gaq.draft.md');
    expect(gaq.diverted).toBe(true);

    writeDraft(root, files);
    expect(readFileSync(path, 'utf8')).toContain('Hand written, do not clobber');
  });

  it('says so in the summary', () => {
    const files = [{ path: 'kb/app/entities/gaq.draft.md', contents: '', diverted: true }];
    expect(formatDraftSummary(DRAFT, [], files)).toContain('existing file kept');
  });
});

describe('the drafted knowledge base is readable by the KB reader', () => {
  it('round-trips through readAppKnowledge', async () => {
    // The two halves have to agree: what B2.5 writes is what B2 reads.
    const result = await draftIt();
    writeDraft(
      root,
      renderDraft({
        draft: result.draft,
        resolutions: result.resolutions,
        manifest: MANIFEST,
        kbDir: 'kb',
        source: 'card.md',
        projectRoot: root,
      }),
    );

    const knowledge = readAppKnowledge(root, 'kb');
    expect(knowledge.warnings).toEqual([]);
    expect(knowledge.entities.map((e) => e.entity)).toEqual(['gaq', 'mvpa-data']);
    expect(knowledge.entities[0]!.states['unfit']!.repository).toBe('UserRepository.updateGAQ');
    expect(knowledge.roles[0]!.id).toBe('customerCare');
  });
});

describe('formatDraftSummary', () => {
  it('leads with what the human must decide', async () => {
    const result = await draftIt();
    const out = formatDraftSummary(result.draft, result.resolutions, []);
    expect(out).toContain('Out of scope for this suite');
    expect(out).toContain('mobile app');
    expect(out).toContain('Setup paths with no matching method');
    expect(out).toContain('Open questions');
    expect(out).toContain('status: draft');
  });
});
