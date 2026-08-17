import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readAppKnowledge } from './kb-app.js';

/**
 * Every read here is forgiving by design. This knowledge is written by people,
 * over time, while they are trying to do something else; a reader that refused
 * to run until every file was perfect would guarantee the files were never
 * written at all.
 */

let root: string;

function write(rel: string, contents: string): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
}

const read = () => readAppKnowledge(root, 'kb');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'flint-kb-app-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('entities', () => {
  it('takes the entity id from the filename', () => {
    // One less thing to write, and one less thing to keep in sync.
    write('kb/app/entities/gaq.md', '---\nstates:\n  unfit:\n    repository: R.m\n---\n# GAQ');
    expect(read().entities[0]!.entity).toBe('gaq');
  });

  it('reads aliases and states', () => {
    write(
      'kb/app/entities/gaq.md',
      '---\naliases: [fitness status]\nstates:\n  unfit:\n    repository: UserRepository.updateGAQ\n    note: value 3\n---\n',
    );
    const entity = read().entities[0]!;
    expect(entity.aliases).toEqual(['fitness status']);
    expect(entity.states['unfit']).toEqual({
      repository: 'UserRepository.updateGAQ',
      note: 'value 3',
    });
  });

  it('accepts an unreachable state', () => {
    write(
      'kb/app/entities/x.md',
      '---\nstates:\n  weird:\n    unreachable: only from the app\n---',
    );
    expect(read().entities[0]!.states['weird']!.unreachable).toBe('only from the app');
  });

  it('warns on a state with no way to reach it, rather than accepting it', () => {
    // A state with neither a setup path nor an `unreachable` reason tells the
    // planner nothing, which is worse than the entity being absent.
    write('kb/app/entities/x.md', '---\nstates:\n  vague:\n    note: hmm\n---');
    const knowledge = read();
    expect(knowledge.entities).toEqual([]);
    expect(knowledge.warnings[0]!.message).toMatch(/repository, flow, api, or unreachable/);
  });

  it('skips `_`-prefixed files, matching the convention elsewhere', () => {
    write('kb/app/entities/_example.md', '---\nstates: {}\n---');
    expect(read().entities).toEqual([]);
  });

  it('keeps the good files when one is malformed', () => {
    write('kb/app/entities/good.md', '---\nstates:\n  a:\n    api: X\n---');
    write('kb/app/entities/bad.md', '---\nstates: [this is not a map]\n---');
    const knowledge = read();
    expect(knowledge.entities.map((e) => e.entity)).toEqual(['good']);
    expect(knowledge.warnings).toHaveLength(1);
  });

  it('warns rather than throwing on a file with no frontmatter', () => {
    write('kb/app/entities/prose.md', '# Just prose, no frontmatter');
    expect(read().warnings[0]!.message).toMatch(/no frontmatter/);
  });
});

describe('roles and glossary', () => {
  it('reads a roles list', () => {
    write(
      'kb/app/roles.md',
      '---\nroles:\n  - id: badgeSupport\n    credentials: getBAPBadgeSupportCredentials\n---',
    );
    expect(read().roles[0]!.credentials).toBe('getBAPBadgeSupportCredentials');
  });

  it('drops one bad entry without losing the rest', () => {
    write('kb/app/roles.md', '---\nroles:\n  - id: ok\n  - notAnId: nope\n---');
    const knowledge = read();
    expect(knowledge.roles.map((r) => r.id)).toEqual(['ok']);
    expect(knowledge.warnings).toHaveLength(1);
  });

  it('reads glossary terms', () => {
    write('kb/app/glossary.md', '---\nterms:\n  - term: MVPA\n    definition: minutes\n---');
    expect(read().glossary[0]!.term).toBe('MVPA');
  });

  it('says so when the list key is missing', () => {
    write('kb/app/glossary.md', '---\nsomethingElse: 1\n---');
    expect(read().warnings[0]!.message).toMatch(/no `terms:` list/);
  });
});

describe('rules', () => {
  it('reads every markdown list item as one rule', () => {
    write(
      'kb/app/rules.md',
      '# Rules\n\n- One per day.\n* Orders over $500 need two approvers.\n\nProse is ignored.',
    );
    expect(read().rules).toEqual(['One per day.', 'Orders over $500 need two approvers.']);
  });
});

describe('an absent knowledge base', () => {
  it('is empty rather than an error', () => {
    // The normal state of a new project, and of every project before someone
    // has had a reason to write any of this down.
    const knowledge = read();
    expect(knowledge.entities).toEqual([]);
    expect(knowledge.warnings).toEqual([]);
  });
});
