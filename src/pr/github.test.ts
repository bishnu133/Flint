import { describe, it, expect } from 'vitest';
import { findToken, parseRemote } from './github.js';

/**
 * Remote parsing is where a PR command quietly does the wrong thing: point it
 * at a GitLab remote and a naive parser happily produces an owner/repo that
 * does not exist on GitHub. Returning undefined is what lets the caller say so.
 */

describe('parseRemote', () => {
  it.each([
    ['https://github.com/acme/widgets.git', 'acme', 'widgets'],
    ['https://github.com/acme/widgets', 'acme', 'widgets'],
    ['http://github.com/acme/widgets', 'acme', 'widgets'],
    ['git@github.com:acme/widgets.git', 'acme', 'widgets'],
    ['git@github.com:acme/widgets', 'acme', 'widgets'],
    ['ssh://git@github.com/acme/widgets.git', 'acme', 'widgets'],
    ['git://github.com/acme/widgets.git', 'acme', 'widgets'],
    ['https://www.github.com/acme/widgets', 'acme', 'widgets'],
  ])('parses %s', (url, owner, repo) => {
    expect(parseRemote(url)).toEqual({ owner, repo });
  });

  it('refuses a GitHub Enterprise host — parsing it would target the public repo', () => {
    // octokit points at api.github.com, so an owner/repo scraped from
    // github.mycorp.com would open the PR on somebody else's public repository.
    expect(parseRemote('https://github.mycorp.com/acme/widgets.git')).toBeUndefined();
    expect(parseRemote('git@github.mycorp.com:acme/widgets.git')).toBeUndefined();
  });

  it('returns undefined for a non-GitHub remote rather than guessing', () => {
    expect(parseRemote('https://gitlab.com/acme/widgets.git')).toBeUndefined();
    expect(parseRemote('https://bitbucket.org/acme/widgets')).toBeUndefined();
    expect(parseRemote('/srv/git/widgets.git')).toBeUndefined();
    expect(parseRemote('')).toBeUndefined();
  });

  it('tolerates surrounding whitespace from git output', () => {
    expect(parseRemote('  git@github.com:acme/widgets.git\n')).toEqual({
      owner: 'acme',
      repo: 'widgets',
    });
  });
});

describe('findToken', () => {
  it('prefers GITHUB_TOKEN, falls back to GH_TOKEN', () => {
    expect(findToken({ GITHUB_TOKEN: 'a', GH_TOKEN: 'b' })).toBe('a');
    expect(findToken({ GH_TOKEN: 'b' })).toBe('b');
  });

  it('treats blank and missing alike — both mean "do the local half"', () => {
    expect(findToken({})).toBeUndefined();
    expect(findToken({ GITHUB_TOKEN: '   ' })).toBeUndefined();
  });
});
