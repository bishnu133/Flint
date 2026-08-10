import { describe, it, expect } from 'vitest';
import { ScreenModelSchema, PageSchema, SelectorCandidateSchema } from './screen-model.js';

const validPage = {
  id: 'page-home',
  url: 'https://app.example.com/',
  urlPattern: '/',
  title: 'Home',
  reachedVia: { kind: 'link', href: '/' },
  elements: [
    {
      id: 'el-login',
      role: 'button',
      name: 'Login',
      tagName: 'button',
      boundingBox: { x: 0, y: 0, width: 80, height: 32 },
      states: { visible: true, enabled: true },
      selectorCandidates: [
        { strategy: 'testid', value: 'login-btn', score: 100, unique: true, verified: true },
      ],
    },
  ],
  navTargets: ['/dashboard'],
  capturedAt: '2026-08-10T00:00:00.000Z',
};

const validModel = {
  version: '1',
  baseUrl: 'https://app.example.com',
  capturedAt: '2026-08-10T00:00:00.000Z',
  pages: [validPage],
};

describe('ScreenModelSchema', () => {
  it('accepts a well-formed model', () => {
    const parsed = ScreenModelSchema.parse(validModel);
    expect(parsed.pages[0]?.elements[0]?.selectorCandidates[0]?.strategy).toBe('testid');
  });

  it('rejects a page url that is not an absolute URL, naming the field', () => {
    const bad = { ...validPage, url: '/relative-only' };
    const result = PageSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues[0];
      expect(issue?.path).toEqual(['url']);
      expect(issue?.message).toMatch(/absolute URL/i);
    }
  });

  it('rejects an unknown selector strategy with a helpful enum message', () => {
    const result = SelectorCandidateSchema.safeParse({
      strategy: 'xpath',
      value: '//button',
      score: 10,
      unique: false,
      verified: false,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues[0];
      expect(issue?.path).toEqual(['strategy']);
      // enum error should enumerate the allowed strategies
      expect(issue?.message).toMatch(/testid/);
    }
  });

  it('rejects an empty selector value with a readable message', () => {
    const result = SelectorCandidateSchema.safeParse({
      strategy: 'css',
      value: '',
      score: 10,
      unique: true,
      verified: true,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/must not be empty/);
    }
  });
});
