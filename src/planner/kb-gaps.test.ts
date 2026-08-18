import { describe, it, expect } from 'vitest';
import type { AppKnowledge, EntityDoc } from '../schemas/kb-app.js';
import { EMPTY_KNOWLEDGE } from '../schemas/kb-app.js';
import { formatGapReport } from './kb-report.js';
import type { SuiteManifest } from '../schemas/manifest.js';
import type { FeatureSpec } from './feature-spec.js';
import {
  checkKbGaps,
  checkKnowledgeIntegrity,
  isBlocking,
  matchEntity,
  matchRole,
  matchState,
  near,
} from './kb-gaps.js';

/**
 * The gap report's value is entirely in being right about two things: what a
 * tester's prose refers to, and whether the suite can actually deliver it.
 * Wrong on the first and it cries wolf; wrong on the second and it waves
 * through a plan that cannot run.
 */

const MANIFEST: SuiteManifest = {
  version: 1,
  generatedAt: '2026-08-17T00:00:00.000Z',
  suiteDir: 'e2e',
  roots: [],
  flows: [
    {
      id: 'badge-creation.createBadge',
      file: 'flows/badge-creation.flow.ts',
      exportName: 'createBadge',
      domain: 'badge-creation',
      kind: 'create',
      params: [],
      returns: 'Promise<void>',
      phrases: [],
      usedBy: [],
    },
  ],
  data: [],
  helpers: [],
  credentials: [
    { getter: 'getBAPBadgeSupportCredentials', file: 'packages/data/BAP.ts', role: 'Badge admin' },
  ],
  repositories: [
    {
      className: 'UserRepository',
      file: 'packages/utilities/repository/UserRepository.ts',
      methods: ['deleteUser', 'updateGAQ'],
    },
    {
      className: 'ActivityRepository',
      file: 'packages/utilities/repository/ActivityRepository.ts',
      methods: ['deleteMVPA'],
    },
  ],
  warnings: [],
};

const GAQ: EntityDoc = {
  entity: 'gaq',
  aliases: ['get active questionnaire', 'fitness status'],
  states: {
    fit: { repository: 'UserRepository.updateGAQ' },
    'partial-fit': { repository: 'UserRepository.updateGAQ' },
    unfit: { repository: 'UserRepository.updateGAQ' },
  },
};

const MVPA: EntityDoc = {
  entity: 'mvpa-progress',
  aliases: ['mvpa minutes'],
  states: {
    synced: { unreachable: 'no DB insert exists; needs an app sync' },
  },
};

function knowledge(over: Partial<AppKnowledge> = {}): AppKnowledge {
  return { entities: [GAQ, MVPA], roles: [], glossary: [], rules: [], warnings: [], ...over };
}

function spec(dataNeeds: string[], over: Record<string, unknown> = {}): FeatureSpec {
  return {
    frontmatter: {
      id: 'mvpa-badge-gaq',
      title: 'MVPA badge',
      priority: 'p0',
      tags: [],
      status: 'draft',
      dataNeeds,
      ...over,
    },
    body: '',
    path: 'kb/features/mvpa-badge-gaq.md',
  } as FeatureSpec;
}

const check = (needs: string[], over: Record<string, unknown> = {}) =>
  checkKbGaps({ spec: spec(needs, over), knowledge: knowledge(), manifest: MANIFEST });

describe('matching a tester’s prose to an entity', () => {
  it('matches on the entity id', () => {
    expect(matchEntity('a user whose GAQ status is unfit', [GAQ, MVPA])?.entity).toBe('gaq');
  });

  it('matches on an alias', () => {
    // The JIRA card says "fitness status"; the KB file is called `gaq`. Without
    // aliases the two never meet and every card reads as ungrounded.
    expect(matchEntity('a user whose fitness status is unfit', [GAQ, MVPA])?.entity).toBe('gaq');
  });

  it('does not match a word that merely contains the id', () => {
    // `gaq` inside another word is a coincidence, not a reference.
    expect(matchEntity('the gaqxyz widget', [GAQ])).toBeUndefined();
  });

  it('prefers the longest match when two entities could apply', () => {
    const user: EntityDoc = { entity: 'user', aliases: [], states: {} };
    expect(matchEntity('a user whose fitness status is unfit', [user, GAQ])?.entity).toBe('gaq');
  });

  it('treats hyphens and spaces alike', () => {
    // `partial-fit` in the KB must match "partial fit" in a spec, or the report
    // blames the author for a punctuation choice.
    expect(matchState('a user whose GAQ status is partial fit', GAQ)).toBe('partial-fit');
  });

  it('prefers the longest state, so `fit` never beats `partial-fit`', () => {
    expect(matchState('partial fit user', GAQ)).toBe('partial-fit');
  });
});

describe('checkKbGaps', () => {
  it('grounds a need that resolves all the way to a repository method', () => {
    const report = check(['a user whose GAQ status is unfit']);
    expect(report.gaps).toEqual([]);
    expect(report.grounded).toEqual([
      {
        need: 'a user whose GAQ status is unfit',
        entity: 'gaq',
        state: 'unfit',
        via: 'UserRepository.updateGAQ',
      },
    ]);
  });

  it('reports an entity nobody has described, and lists what is known', () => {
    const report = check(['a user with a verified Singpass account']);
    expect(report.gaps[0]!.kind).toBe('unknown-entity');
    expect(report.gaps[0]!.fix).toContain('kb/app/entities/');
    expect(report.gaps[0]!.candidates).toEqual(['gaq', 'mvpa-progress']);
  });

  it('reports a described entity missing the state asked for', () => {
    const report = check(['a user whose GAQ status is pending']);
    expect(report.gaps[0]!.kind).toBe('unknown-state');
    expect(report.gaps[0]!.candidates).toEqual(['fit', 'partial-fit', 'unfit']);
    expect(report.gaps[0]!.fix).toContain('entities/gaq.md');
  });

  it('reports a documented dead end as a gap, with the recorded reason', () => {
    // The honest answer to "can this be automated" is sometimes no, and the
    // operator should hear it before paying to plan the feature.
    const report = check(['a user who has synced some MVPA progress']);
    expect(report.gaps[0]!.kind).toBe('unreachable-state');
    expect(report.gaps[0]!.reason).toContain('needs an app sync');
  });

  it('catches a KB reference to a method that does not exist', () => {
    const broken: EntityDoc = {
      entity: 'gaq',
      aliases: [],
      states: { unfit: { repository: 'UserRepository.setGAQStatus' } },
    };
    const report = checkKbGaps({
      spec: spec(['a user whose GAQ status is unfit']),
      knowledge: knowledge({ entities: [broken] }),
      manifest: MANIFEST,
    });
    expect(report.gaps[0]!.kind).toBe('dangling-reference');
    expect(report.gaps[0]!.candidates).toContain('updateGAQ');
  });

  it('catches a reference to a repository class that does not exist', () => {
    const broken: EntityDoc = {
      entity: 'gaq',
      aliases: [],
      states: { unfit: { repository: 'UsersRepository.updateGAQ' } },
    };
    const report = checkKbGaps({
      spec: spec(['gaq unfit']),
      knowledge: knowledge({ entities: [broken] }),
      manifest: MANIFEST,
    });
    expect(report.gaps[0]!.reason).toContain('UsersRepository');
    expect(report.gaps[0]!.candidates).toContain('UserRepository');
  });

  it('grounds a state reached by an existing flow', () => {
    const badge: EntityDoc = {
      entity: 'badge',
      aliases: [],
      states: { live: { flow: 'badge-creation.createBadge' } },
    };
    const report = checkKbGaps({
      spec: spec(['a live badge']),
      knowledge: knowledge({ entities: [badge] }),
      manifest: MANIFEST,
    });
    expect(report.gaps).toEqual([]);
    expect(report.grounded[0]!.via).toBe('flow badge-creation.createBadge');
  });

  it('says nothing at all when a spec declares no data needs', () => {
    const report = checkKbGaps({
      spec: spec([]),
      knowledge: knowledge(),
      manifest: MANIFEST,
    });
    expect(report.gaps).toEqual([]);
    expect(report.grounded).toEqual([]);
  });

  it('checks page hints only when a Screen Model exists', () => {
    // Before the first `flint explore` there is no model, and flagging every
    // hint as unknown would be noise rather than a finding.
    const withoutModel = check([], { pages: ['/badges'] });
    expect(withoutModel.gaps).toEqual([]);

    const withModel = checkKbGaps({
      spec: spec([], { pages: ['/badges'] }),
      knowledge: knowledge(),
      manifest: MANIFEST,
      knownPages: ['/activities', '/workouts'],
    });
    expect(withModel.gaps[0]!.kind).toBe('unknown-page');
  });

  it('accepts a page hint that a urlPattern contains', () => {
    const report = checkKbGaps({
      spec: spec([], { pages: ['badges'] }),
      knowledge: knowledge(),
      manifest: MANIFEST,
      knownPages: ['/badges/:id'],
    });
    expect(report.gaps).toEqual([]);
  });
});

describe('checkKnowledgeIntegrity', () => {
  // The KB is checked whole, not only where today's feature happens to touch
  // it. A method renamed last week already broke these references; finding them
  // one feature at a time means finding them months apart.
  it('finds a broken reference no feature currently uses', () => {
    const badge: EntityDoc = {
      entity: 'badge',
      aliases: [],
      states: {
        live: { flow: 'badge-creation.createBadge' },
        upcoming: { flow: 'badge-creation.createBadgeUpcoming' },
      },
    };
    const gaps = checkKnowledgeIntegrity(knowledge({ entities: [badge] }), MANIFEST);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.what).toContain('createBadgeUpcoming');
    expect(gaps[0]!.candidates).toContain('badge-creation.createBadge');
  });

  it('finds a role naming a credential getter that does not exist', () => {
    const gaps = checkKnowledgeIntegrity(
      knowledge({
        roles: [{ id: 'badgeSupport', credentials: 'getBadgeSupportCredentials', aliases: [] }],
      }),
      MANIFEST,
    );
    expect(gaps[0]!.kind).toBe('dangling-reference');
    expect(gaps[0]!.candidates).toContain('getBAPBadgeSupportCredentials');
  });

  it('is silent when every reference resolves', () => {
    expect(checkKnowledgeIntegrity(knowledge(), MANIFEST)).toEqual([]);
  });

  it('ignores a role that names no credentials', () => {
    const gaps = checkKnowledgeIntegrity(
      knowledge({ roles: [{ id: 'anonymous', aliases: [] }] }),
      MANIFEST,
    );
    expect(gaps).toEqual([]);
  });
});

describe('near', () => {
  it('matches the right noun with the wrong verb', () => {
    // The mistake people actually make. These two share no substring, so a
    // substring check would offer nothing exactly where a suggestion helps most.
    expect(near('setGAQStatus', ['updateGAQ', 'deleteUser'])).toEqual(['updateGAQ']);
  });

  it('matches across a missing prefix', () => {
    expect(
      near('getBadgeSupportCredentials', ['getBAPBadgeSupportCredentials', 'getPrqCredentials']),
    ).toEqual(['getBAPBadgeSupportCredentials']);
  });

  it('matches a plural against a singular', () => {
    expect(near('UsersRepository', ['UserRepository', 'BadgeRepository'])).toEqual([
      'UserRepository',
    ]);
  });

  it('ignores case', () => {
    expect(near('updateGaq', ['updateGAQ', 'deleteUser'])).toEqual(['updateGAQ']);
  });

  it('does not suggest on a shared generic word alone', () => {
    // Every repository shares "Repository"; suggesting all of them is a
    // suggestion with no information in it.
    expect(near('WidgetRepository', ['UserRepository', 'BadgeRepository'])).toEqual([]);
  });

  it('is empty when nothing is close', () => {
    expect(near('somethingElse', ['updateGAQ', 'deleteUser'])).toEqual([]);
  });
});

describe('isBlocking', () => {
  it('blocks on broken references and dead ends, not on missing prose', () => {
    expect(isBlocking({ kind: 'dangling-reference' } as never)).toBe(true);
    expect(isBlocking({ kind: 'unreachable-state' } as never)).toBe(true);
    expect(isBlocking({ kind: 'unknown-entity' } as never)).toBe(false);
  });
});

describe('formatGapReport — nothing to check is not a pass', () => {
  // The first run against a real project printed "All 0 declared data need(s)
  // are grounded" for a repo with no specs at all. Someone whose specs sit in
  // the wrong directory would read that as confirmation and move on.
  it('says no specs were found rather than reporting a pass', () => {
    const out = formatGapReport([], EMPTY_KNOWLEDGE);
    expect(out).toContain('No feature specs found');
    expect(out).not.toContain('grounded.');
  });

  it('distinguishes specs with no data needs from specs that all check out', () => {
    const noNeeds = formatGapReport(
      [{ featureId: 'login', gaps: [], grounded: [] }],
      EMPTY_KNOWLEDGE,
    );
    expect(noNeeds).toContain('nothing to ground');

    const allGood = formatGapReport(
      [
        {
          featureId: 'login',
          gaps: [],
          grounded: [{ need: 'a user', entity: 'user', state: 'active', via: 'R.m' }],
        },
      ],
      EMPTY_KNOWLEDGE,
    );
    expect(allGood).toContain('All 1 declared data need(s) are grounded.');
  });
});

describe('roles as a data need', () => {
  // "a BAP user with customer support roles" is the most common precondition in
  // a real card, and it lives in roles.md rather than as an entity with states.
  // Checking only entities reported it as undescribed on the first real spec.
  const roles = [
    {
      id: 'customerCare',
      credentials: 'getBAPCusCareCredentials',
      aliases: ['customer care', 'customer support'],
    },
  ];

  it('grounds a role need to its credential getter', () => {
    const report = checkKbGaps({
      spec: spec(['a BAP user with the customer care role']),
      knowledge: knowledge({ roles }),
      manifest: {
        ...MANIFEST,
        credentials: [{ getter: 'getBAPCusCareCredentials', file: 'packages/data/BAP.ts' }],
      },
    });
    expect(report.gaps).toEqual([]);
    expect(report.grounded[0]).toEqual({
      need: 'a BAP user with the customer care role',
      entity: 'role',
      state: 'customerCare',
      via: 'getBAPCusCareCredentials',
    });
  });

  it('matches a role by alias', () => {
    expect(matchRole('a BAP user with customer support roles', roles)?.id).toBe('customerCare');
  });

  it('reports a role that names no credentials', () => {
    const report = checkKbGaps({
      spec: spec(['a customer care user']),
      knowledge: knowledge({ roles: [{ id: 'customerCare', aliases: ['customer care'] }] }),
      manifest: MANIFEST,
    });
    expect(report.gaps[0]!.fix).toContain('roles.md');
  });

  it('lists roles alongside entities when nothing matches', () => {
    const report = checkKbGaps({
      spec: spec(['something nobody wrote down']),
      knowledge: knowledge({ roles }),
      manifest: MANIFEST,
    });
    expect(report.gaps[0]!.candidates).toContain('role:customerCare');
  });
});
