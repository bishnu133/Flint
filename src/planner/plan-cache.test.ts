import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FeatureSpec } from '../schemas/kb.js';
import type { ScreenModel } from '../schemas/screen-model.js';
import type { TestPlan } from '../schemas/test-plan.js';
import type { LLMProvider } from '../llm/types.js';
import {
  generatePlanCached,
  planCacheKey,
  planCachePath,
  readCacheEntry,
  writeCacheEntry,
} from './plan-cache.js';
import { planPath, writePlan } from './store.js';

/**
 * The cache exists to make an unchanged re-run free and repeatable. Both halves
 * matter: serving a stale plan would be worse than paying for a fresh one, so
 * most of these tests are about when the cache must *miss*.
 */

let root: string;

const MODEL: ScreenModel = {
  version: '2026-08-14T00:00:00.000Z',
  baseUrl: 'https://www.saucedemo.com',
  generatedAt: '2026-08-14T00:00:00.000Z',
  pages: [
    {
      id: 'login',
      url: 'https://www.saucedemo.com/',
      urlPattern: '/',
      title: 'Swag Labs',
      reachedVia: { kind: 'link', href: '/' },
      capturedAt: '2026-08-14T00:00:00.000Z',
      navTargets: [],
      elements: [
        {
          id: 'login.username',
          role: 'textbox',
          name: 'Username',
          tagName: 'input',
          boundingBox: { x: 0, y: 0, width: 10, height: 10 },
          states: { visible: true, enabled: true },
          selectorCandidates: [
            { strategy: 'testid', value: 'username', score: 100, unique: true, verified: true },
          ],
        },
      ],
    },
  ],
};

function spec(
  over: Partial<FeatureSpec['frontmatter']> = {},
  body = 'Sign in works.',
): FeatureSpec {
  return {
    frontmatter: {
      id: 'login',
      title: 'Login',
      priority: 'p0',
      tags: [],
      status: 'draft',
      ...over,
    },
    body,
    path: 'kb/features/login.md',
  } as FeatureSpec;
}

const PLAN: TestPlan = {
  featureId: 'login',
  generatedAt: '2026-08-14T00:00:00.000Z',
  screenModelVersion: MODEL.version,
  cases: [
    {
      id: 'login-1',
      title: 'signs in',
      priority: 'p0',
      tags: ['@p0'],
      status: 'new',
      steps: [{ action: 'goto', value: '/' }],
    },
  ],
};

/** Fails the test if the planner is ever reached. */
const NEVER_CALLED: LLMProvider = {
  complete: () => {
    throw new Error('provider called — expected a cache hit');
  },
  structured: () => {
    throw new Error('provider called — expected a cache hit');
  },
} as unknown as LLMProvider;

function options(over: Record<string, unknown> = {}) {
  return {
    projectRoot: root,
    spec: spec(),
    model: MODEL,
    provider: NEVER_CALLED,
    modelId: 'claude-opus-5',
    tokenBudget: 30_000,
    ...over,
  } as Parameters<typeof generatePlanCached>[0];
}

/** Put a plan and a matching key on disk, as a successful run would. */
function seed(over: Record<string, unknown> = {}): void {
  const opts = options(over);
  writePlan(planPath(root, 'login'), PLAN);
  writeCacheEntry(root, 'login', {
    key: planCacheKey(opts).key,
    model: opts.modelId,
    cachedAt: '2026-08-14T00:00:00.000Z',
    promptTokens: 100,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'flint-plan-cache-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('planCacheKey', () => {
  it('is stable for identical inputs', () => {
    expect(planCacheKey(options()).key).toBe(planCacheKey(options()).key);
  });

  it('changes when the spec body changes', () => {
    const a = planCacheKey(options()).key;
    const b = planCacheKey(options({ spec: spec({}, 'Sign in works, and fails loudly.') })).key;
    expect(a).not.toBe(b);
  });

  it('changes when the model id changes', () => {
    // Otherwise switching planner to a cheaper model would silently keep
    // serving the expensive model's plans, and the config change would look
    // like it had no effect.
    expect(planCacheKey(options()).key).not.toBe(
      planCacheKey(options({ modelId: 'claude-sonnet-5' })).key,
    );
  });

  it('changes when the Screen Model changes', () => {
    const redrawn = { ...MODEL, version: '2026-09-01T00:00:00.000Z' };
    expect(planCacheKey(options()).key).not.toBe(planCacheKey(options({ model: redrawn })).key);
  });

  it('changes when the conventions change', () => {
    expect(planCacheKey(options()).key).not.toBe(
      planCacheKey(options({ conventions: 'Always assert the URL.' })).key,
    );
  });
});

describe('generatePlanCached', () => {
  it('reuses the stored plan without calling the model', async () => {
    seed();
    const result = await generatePlanCached(options());
    expect(result.cacheHit).toBe(true);
    expect(result.plan.cases).toHaveLength(1);
  });

  it('misses when the spec changed', async () => {
    seed();
    // NEVER_CALLED throws, which is the assertion: a miss must reach the model.
    await expect(
      generatePlanCached(options({ spec: spec({}, 'Different acceptance criteria.') })),
    ).rejects.toThrow(/provider called/);
  });

  it('misses when --replan forces it', async () => {
    seed();
    await expect(generatePlanCached(options({ force: true }))).rejects.toThrow(/provider called/);
  });

  it('misses when the plan file is gone even though the key matches', async () => {
    seed();
    rmSync(planPath(root, 'login'));
    await expect(generatePlanCached(options())).rejects.toThrow(/provider called/);
  });

  it('misses when the plan on disk is corrupt', async () => {
    seed();
    writeFileSync(planPath(root, 'login'), '{ not json', 'utf8');
    await expect(generatePlanCached(options())).rejects.toThrow(/provider called/);
  });

  it('serves a hand-edited plan rather than shadowing it', async () => {
    // The plan file is the single copy. Someone who tightens an assertion by
    // hand must get their version, not a cached duplicate of the original.
    seed();
    const edited: TestPlan = {
      ...PLAN,
      cases: [{ ...PLAN.cases[0]!, title: 'signs in with a valid account' }],
    };
    writePlan(planPath(root, 'login'), edited);

    const result = await generatePlanCached(options());
    expect(result.cacheHit).toBe(true);
    expect(result.plan.cases[0]!.title).toBe('signs in with a valid account');
  });

  it('does not write the entry itself', async () => {
    // The caller writes it, and only once the plan is persisted. If this ever
    // starts writing, a failed compile gate leaves a key pointing at the
    // previous run's plan and the next run serves the wrong one.
    seed();
    rmSync(planCachePath(root, 'login'));
    await expect(generatePlanCached(options())).rejects.toThrow(/provider called/);
    expect(existsSync(planCachePath(root, 'login'))).toBe(false);
  });

  it('hands back the entry for the caller to commit', async () => {
    seed();
    const result = await generatePlanCached(options());
    expect(result.cacheEntry.key).toBe(planCacheKey(options()).key);
    expect(result.cacheEntry.model).toBe('claude-opus-5');
  });
});

describe('readCacheEntry', () => {
  it('treats a corrupt entry as absent', () => {
    seed();
    writeFileSync(planCachePath(root, 'login'), 'not json at all', 'utf8');
    expect(readCacheEntry(root, 'login')).toBeUndefined();
  });

  it('is undefined when nothing was ever cached', () => {
    expect(readCacheEntry(root, 'nothing')).toBeUndefined();
  });
});
