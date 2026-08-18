import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { FakeProvider } from '../llm/fake.js';
import type { SuiteManifest } from '../schemas/manifest.js';
import type { DraftedKb } from '../schemas/draft.js';
import { DraftedKbSchema } from '../schemas/draft.js';
import { documentWarning, draftKnowledgeBase, hintCandidates, resolveSetup } from './draft.js';
import { checkDraftNeeds } from './draft-check.js';
import { EMPTY_KNOWLEDGE } from '../schemas/kb-app.js';
import { loadAndRender } from '../generator/template-loader.js';
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
    {
      what: 'AC6-AC9 (H365 Activity Dashboard)',
      why: 'mobile app; this suite drives the web portal',
    },
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
    expect(formatDraftSummary(DRAFT, [], files, [])).toContain('existing file kept');
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
    const out = formatDraftSummary(result.draft, result.resolutions, [], result.needs);
    expect(out).toContain('Out of scope for this suite');
    expect(out).toContain('mobile app');
    expect(out).toContain('Setup paths with no matching method');
    expect(out).toContain('Open questions');
    expect(out).toContain('status: draft');
  });
});

describe('the prompt has an output contract, and it comes last', () => {
  // The first live run produced 8333 output tokens and no JSON at all. The
  // template described the fields in prose and never said "return JSON" or
  // showed the shape — the provider's one-line system instruction was not
  // enough once the user prompt ended with 45k tokens of conversational JIRA
  // card. `plan-stage-a.md` had had an explicit Output section all along.
  const rendered = () =>
    loadAndRender('draft-kb', {
      document: 'DOCUMENT-BODY',
      suite: 'SUITE',
      screens: 'SCREENS',
      existing: 'EXISTING',
    }).text;

  it('states the output shape', () => {
    const text = rendered();
    expect(text).toContain('Return **only** a JSON object');
    for (const key of ['features', 'entities', 'roles', 'outOfScope', 'openQuestions']) {
      expect(text).toContain(`"${key}"`);
    }
  });

  it('puts the output contract after the document', () => {
    // Ordering is the fix, not decoration. A requirement document reads like
    // something to reply to; the last instruction before generation has to be
    // what to actually return.
    const text = rendered();
    expect(text.indexOf('DOCUMENT-BODY')).toBeLessThan(text.indexOf('# Output'));
  });

  it('names every field the schema requires of a state', () => {
    const text = rendered();
    expect(text).toContain('setupHint');
    expect(text).toContain('unreachableReason');
  });
});

describe('documentWarning', () => {
  // A JIRA XML export of one card cost 49,705 input tokens where the same card
  // as text was under 3,000 — markup the model has to read past, billed per
  // token, on every draft.
  it('says nothing about a normal-sized document', () => {
    expect(documentWarning('a'.repeat(20_000), 'card.md')).toBeUndefined();
  });

  it('flags a document large enough to be an export artefact', () => {
    const warning = documentWarning('a'.repeat(200_000), 'HPBPPH-17169.xml');
    expect(warning).toContain('HPBPPH-17169.xml');
    expect(warning).toMatch(/markup|export/i);
  });

  it('names the format when the extension is a known noisy one', () => {
    expect(documentWarning('a'.repeat(200_000), 'card.xml')).toMatch(/\.xml/);
    expect(documentWarning('a'.repeat(200_000), 'card.html')).toMatch(/\.html/);
  });
});

describe('feature ids are capped, because they become filenames and tags', () => {
  // A live run produced `activity-data-mvpa-split-on-gaq-status-change-within-day`
  // — 56 characters, which would appear beside every test result for the life
  // of the suite. Rejecting it costs one short retry.
  const withId = (id: string) => ({ ...DRAFT, features: [{ ...DRAFT.features[0]!, id }] });

  it('rejects an id long enough to make test output unreadable', () => {
    const result = DraftedKbSchema.safeParse(
      withId('activity-data-mvpa-split-on-gaq-status-change-within-day'),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain('three or four words');
  });

  it('accepts a sensible one', () => {
    expect(DraftedKbSchema.safeParse(withId('unfit-mvpa-column')).success).toBe(true);
  });

  it('still rejects non-kebab-case', () => {
    expect(DraftedKbSchema.safeParse(withId('Unfit_MVPA_Column')).success).toBe(false);
  });
});

describe('the prompt teaches the splitting rules that a live run got wrong', () => {
  const text = () =>
    loadAndRender('draft-kb', {
      document: 'D',
      suite: 'S',
      screens: 'SC',
      existing: 'E',
    }).text;

  it('gives a concrete example of two requirements that are one feature', () => {
    // The abstract rule was already there and was not enough: one run split
    // "value in column A when status P" from "value in column B when status Q".
    expect(text()).toContain('are **one** feature');
  });

  it('says what an id should cost', () => {
    expect(text()).toContain('three or four words');
  });

  it('tests an entity by whether a test must set it up', () => {
    // One run proposed `h365-user` and `tracker` as entities — nouns from the
    // document that no test would ever have to put into a state.
    // Whitespace-insensitive: the phrase wraps across lines in the template,
    // and a test that breaks on rewrapping would be a test of the line width.
    expect(text().replace(/\s+/g, ' ')).toContain('would a test have to *set this up*');
  });
});

describe('the summary shows what each feature claims to cover', () => {
  // A run that collapsed five requirements into one feature printed the same
  // shape as one that dropped four of them: a file count and nothing else.
  // The split is the thing a reviewer most needs to see.
  it('prints covers beside the spec file', () => {
    const out = formatDraftSummary(
      DRAFT,
      [],
      [{ path: 'kb/features/unfit-mvpa-column.md', contents: '', diverted: false }],
      [],
    );
    expect(out).toContain('covers: AC1');
  });

  it('says nothing when a feature cites no requirement', () => {
    const uncited = { ...DRAFT, features: [{ ...DRAFT.features[0]!, covers: [] }] };
    const out = formatDraftSummary(
      uncited,
      [],
      [{ path: 'kb/features/unfit-mvpa-column.md', contents: '', diverted: false }],
      [],
    );
    expect(out).not.toContain('covers:');
  });
});

describe('the prompt resolves the two splitting rules against each other', () => {
  const text = () =>
    loadAndRender('draft-kb', { document: 'D', suite: 'S', screens: 'SC', existing: 'E' }).text;

  it('says preconditions win over shape', () => {
    // Strengthening the merge rule alone swung a run from four features to one,
    // locking a requirement that needed no setup in with ones that cannot run.
    expect(text()).toContain('preconditions win');
  });

  it('forbids a requirement going missing', () => {
    expect(text().replace(/\s+/g, ' ')).toContain('Nothing may disappear');
  });
});

describe('a draft has to ground its own preconditions', () => {
  /**
   * The live case, verbatim. `flint draft` wrote four good-looking files from
   * HPBPPH-17236 and `flint kb` scored them **0 grounded, 3 gaps** — because the
   * need is a sentence and the state is a filename, and the gap check joins them
   * by words. Neither half was wrong on its own, which is why nothing caught it.
   */
  const mismatched: DraftedKb = {
    ...DRAFT,
    features: [
      {
        ...DRAFT.features[0]!,
        dataNeeds: [
          'a BAP user with Vendor Admin role who is not assigned the HPB Activity Vendor User Manager role',
        ],
      },
    ],
    entities: [
      {
        entity: 'vendor-admin-role',
        aliases: [],
        states: [{ name: 'h365-vendor-admin-without-manager', setupHint: 'log in as one' }],
      },
    ],
    roles: [],
  };

  it('reports a need whose state name does not read inside it', () => {
    const [check] = checkDraftNeeds(mismatched);
    expect(check!.status).toBe('no-state');
    expect(check!.entity).toBe('vendor-admin-role');
    expect(check!.known).toEqual(['h365-vendor-admin-without-manager']);
  });

  it('grounds the same need once the pair is written in the same words', () => {
    const paired: DraftedKb = {
      ...mismatched,
      features: [
        {
          ...mismatched.features[0]!,
          dataNeeds: ['a vendor admin without manager access'],
        },
      ],
      entities: [
        {
          entity: 'vendor-admin',
          aliases: [],
          states: [{ name: 'without-manager', setupHint: 'log in as one' }],
        },
      ],
    };
    expect(checkDraftNeeds(paired).map((c) => c.status)).toEqual(['grounded']);
  });

  it('grounds a need through a role, the way the gap report does', () => {
    // Roles are checked before entities: "a BAP user with the customer care
    // role" is satisfied by a credential getter, not by seeded data.
    expect(checkDraftNeeds(DRAFT).map((c) => c.status)).toEqual(['grounded']);
  });

  it('reports a need that matches nothing at all', () => {
    const orphan: DraftedKb = { ...mismatched, entities: [], roles: [] };
    const [check] = checkDraftNeeds(orphan);
    expect(check!.status).toBe('no-entity');
    expect(check!.known).toEqual([]);
  });

  it('counts a knowledge base that already exists', () => {
    // A draft extends a KB rather than replacing it. Reporting a need as
    // stranded when last month's entity file already grounds it would send a
    // reviewer to write a file that is sitting there.
    const checks = checkDraftNeeds(
      { ...mismatched, entities: [], roles: [] },
      {
        ...EMPTY_KNOWLEDGE,
        roles: [{ id: 'vendorAdmin', aliases: ['Vendor Admin role'] }],
      },
    );
    expect(checks.map((c) => c.status)).toEqual(['grounded']);
  });

  it('says so in the summary, not two commands later', () => {
    const out = formatDraftSummary(mismatched, [], [], checkDraftNeeds(mismatched));
    expect(out).toContain('Preconditions that will not ground');
    expect(out).toContain('h365-vendor-admin-without-manager');
    expect(out).toContain('read inside');
  });

  it('stays quiet when every need grounds', () => {
    expect(formatDraftSummary(DRAFT, [], [], checkDraftNeeds(DRAFT))).not.toContain(
      'will not ground',
    );
  });
});

describe('the prompt asks for a need and a state written in the same words', () => {
  const text = () =>
    loadAndRender('draft-kb', { document: 'D', suite: 'S', screens: 'SC', existing: 'E' }).text;

  it('explains that grounding is word matching', () => {
    expect(text().replace(/\s+/g, ' ')).toContain('A need must name the thing that satisfies it');
  });

  it('sends a login to roles rather than to an entity with states', () => {
    expect(text()).toContain('Who is logged in is a role, not an entity');
  });

  it('says a role alias is what matches, because the id never reads as prose', () => {
    expect(text()).toContain('camelCase');
  });

  it('says pages are url fragments, not screen names', () => {
    // A live run wrote `pages: - Facilitators tab / Facilitator listing page`,
    // which matches no screen and sends the planner nowhere useful.
    expect(text().replace(/\s+/g, ' ')).toContain('holds **URL fragments**');
  });
});

describe('candidates for a setup hint', () => {
  const methods = [
    'ActivityDashboardGoalRepository.deleteGoalsForUser',
    'ActivityDashboardGoalRepository.updateBaselineAcknowledgementForUser',
    'BadgeRepository.cleanupBadgeTestData',
    'UserRepository.updateGAQ',
  ];

  it('offers a near miss when the hint is short enough to be a name', () => {
    expect(hintCandidates('call UserRepository.setGAQStatus', methods, [])).toContain(
      'UserRepository.updateGAQ',
    );
  });

  it('offers nothing when the hint is a sentence', () => {
    // A live run offered five repositories about dashboard goals as the closest
    // match for "log in as a Vendor Admin", on the strength of sharing the word
    // "user". Noise printed exactly where a reader is scanning for a lead.
    expect(
      hintCandidates(
        'Log in as a user assigned the Vendor Admin role but not the HPB Activity Vendor User Manager role',
        methods,
        [],
      ),
    ).toEqual([]);
  });
});
