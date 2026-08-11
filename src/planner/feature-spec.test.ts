import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverFeatureFiles,
  listFeatureIds,
  parseFeatureSpec,
  readAllFeatureSpecs,
  readFeatureSpec,
} from './feature-spec.js';
import { ConfigError } from '../shared/errors.js';

let root: string;

/** The actionable half of a FlintError lives in `hint`, which the CLI prints. */
function hintOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as ConfigError).hint ?? '';
  }
  throw new Error('expected the call to throw');
}

function writeSpec(name: string, contents: string): void {
  const dir = join(root, 'kb', 'features');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), contents, 'utf8');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'flint-spec-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const VALID = `---
id: checkout
title: Checkout
priority: p0
pages:
  - /cart
  - /checkout
acceptanceCriteria:
  - A user can complete a purchase
tags: [smoke]
---

Prose for the planner.
`;

describe('parseFeatureSpec', () => {
  it('splits frontmatter from body', () => {
    const spec = parseFeatureSpec(VALID, 'checkout.md');
    expect(spec.frontmatter.id).toBe('checkout');
    expect(spec.frontmatter.pages).toEqual(['/cart', '/checkout']);
    expect(spec.body).toBe('Prose for the planner.');
  });

  it('applies schema defaults', () => {
    const spec = parseFeatureSpec('---\nid: a\ntitle: A\n---\n', 'a.md');
    expect(spec.frontmatter.priority).toBe('p1');
    expect(spec.frontmatter.status).toBe('draft');
    expect(spec.frontmatter.tags).toEqual([]);
  });

  it('errors actionably when there is no frontmatter', () => {
    expect(() => parseFeatureSpec('Just prose.', 'x.md')).toThrowError(ConfigError);
    expect(() => parseFeatureSpec('Just prose.', 'x.md')).toThrow(/no frontmatter/);
  });

  it('errors actionably on malformed YAML', () => {
    expect(() => parseFeatureSpec('---\nid: [unclosed\n---\n', 'x.md')).toThrow(/not valid YAML/);
  });

  it('names the offending key when the shape is wrong', () => {
    // `id` must be kebab-case.
    expect(() => parseFeatureSpec('---\nid: Not Kebab\ntitle: X\n---\n', 'x.md')).toThrow(/id/);
  });

  it('rejects an unknown key rather than ignoring a typo', () => {
    expect(() =>
      parseFeatureSpec('---\nid: a\ntitle: A\nacceptancecriteria: [x]\n---\n', 'x.md'),
    ).toThrow(/validation/);
  });

  it('handles CRLF line endings', () => {
    const spec = parseFeatureSpec('---\r\nid: a\r\ntitle: A\r\n---\r\n\r\nBody.\r\n', 'a.md');
    expect(spec.frontmatter.id).toBe('a');
    expect(spec.body).toBe('Body.');
  });
});

describe('discoverFeatureFiles / readFeatureSpec', () => {
  it('lists specs in sorted order and skips _-prefixed docs', () => {
    writeSpec('b.md', '---\nid: b\ntitle: B\n---\n');
    writeSpec('a.md', '---\nid: a\ntitle: A\n---\n');
    writeSpec('_notes.md', '# not a spec');
    const names = discoverFeatureFiles(root, 'kb').map((p) => p.split('/').pop());
    expect(names).toEqual(['a.md', 'b.md']);
  });

  it('returns an empty list when the directory does not exist', () => {
    expect(discoverFeatureFiles(root, 'kb')).toEqual([]);
  });

  it('reads a spec by id', () => {
    writeSpec('checkout.md', VALID);
    expect(readFeatureSpec(root, 'kb', 'checkout').frontmatter.title).toBe('Checkout');
  });

  it('finds a spec whose filename does not match its id', () => {
    // The frontmatter is authoritative, not the filename.
    writeSpec('renamed.md', VALID);
    expect(readFeatureSpec(root, 'kb', 'checkout').frontmatter.id).toBe('checkout');
  });

  it('lists what is available when the id is unknown', () => {
    writeSpec('checkout.md', VALID);
    expect(() => readFeatureSpec(root, 'kb', 'nope')).toThrow(/No feature spec with id/);
    expect(hintOf(() => readFeatureSpec(root, 'kb', 'nope'))).toMatch(/Available: checkout/);
  });

  it('suggests creating one when there are no specs at all', () => {
    expect(hintOf(() => readFeatureSpec(root, 'kb', 'nope'))).toMatch(/Create one at/);
  });

  it('readAllFeatureSpecs surfaces a broken spec rather than skipping it', () => {
    writeSpec('good.md', '---\nid: good\ntitle: Good\n---\n');
    writeSpec('bad.md', 'no frontmatter');
    expect(() => readAllFeatureSpecs(root, 'kb')).toThrow(/no frontmatter/);
  });

  it('listFeatureIds tolerates a broken spec so other errors stay readable', () => {
    writeSpec('good.md', '---\nid: good\ntitle: Good\n---\n');
    writeSpec('bad.md', 'no frontmatter');
    const ids = listFeatureIds(root, 'kb');
    expect(ids).toContain('good');
    expect(ids.some((id) => id.includes('unreadable'))).toBe(true);
  });
});
