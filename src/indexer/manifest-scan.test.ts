import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { scanManifest, flowKindOf, roleFromGetter } from './manifest-scan.js';
import { isEmptyManifest } from '../schemas/manifest.js';

/**
 * The fixtures mirror the four-layer pattern of a real Bubblegum suite —
 * dynamic imports in tests, JSDoc on every flow, `act`/`verify` phrases inline
 * — because the scanner's whole value is being right about that shape.
 */

let root: string;

function write(rel: string, contents: string): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
}

function scan(extraRoots?: string[]) {
  return scanManifest({
    projectRoot: root,
    suiteDir: 'e2e',
    ...(extraRoots !== undefined ? { extraRoots } : {}),
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'flint-manifest-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const LOGIN_FLOW = `
import type { Page } from '@playwright/test';
import type { Bubblegum } from '@bubblegum-ai/node';
import { act, verify } from '../helpers/actions';

/**
 * Logs into the BAP portal. Expects the page to be on the login screen.
 */
export async function loginFlow(
  engine: Bubblegum,
  page: Page,
  credentials: Credentials,
): Promise<void> {
  await act(engine, \`Enter "\${credentials.username}" into Username\`);
  await act(engine, 'Click Sign In');
  await verify(engine, 'the page header is "Dashboard"');
}

/** Clicks My Account then Logout. */
export async function logoutFlow(engine: Bubblegum, page: Page): Promise<void> {
  await act(engine, 'Click the My Account menu');
}
`;

const BADGE_FLOW = `
import { act, getRunConsole } from '../helpers/actions';

/**
 * Navigates to the Badges page from any page in the portal.
 */
export async function navigateToBadges(engine: Bubblegum, page: Page): Promise<void> {
  await act(engine, 'Click the Badges menu');
}

/**
 * Creates a badge and returns its generated name.
 */
export async function createBadge(engine: Bubblegum, page: Page): Promise<string> {
  getRunConsole()?.section('Create');
  await act(engine, 'Click the + Create badge button');
  return 'name';
}
`;

const BADGE_TEST = `
import dotenv from 'dotenv';
dotenv.config({ path: '.env.bubblegum.local' });

const { loginFlow } = await import('../flows/login.flow');
const { navigateToBadges, createBadge } = await import('../flows/badge-creation.flow');
`;

function seedSuite(): void {
  write('e2e/flows/login.flow.ts', LOGIN_FLOW);
  write('e2e/flows/badge-creation.flow.ts', BADGE_FLOW);
  write('e2e/tests/badge-creation.test.mts', BADGE_TEST);
  write(
    'e2e/data/badge.data.ts',
    `export const badgeFormData = { namePrefix: 'AutoBadge', description: 'x' };`,
  );
  write(
    'e2e/helpers/actions.ts',
    `/** Performs a UI action, throwing on failure. */
     export const act = (bg: Bubblegum, s: string) => bg.act(s);
     export function getRunConsole(): void {}`,
  );
}

describe('scanManifest — flows', () => {
  it('finds every exported flow with its file and domain', () => {
    seedSuite();
    const ids = scan().flows.map((f) => f.id);
    expect(ids).toEqual([
      'badge-creation.createBadge',
      'badge-creation.navigateToBadges',
      'login.loginFlow',
      'login.logoutFlow',
    ]);
  });

  it('reads the summary from JSDoc', () => {
    seedSuite();
    const login = scan().flows.find((f) => f.id === 'login.loginFlow');
    expect(login?.summary).toBe(
      'Logs into the BAP portal. Expects the page to be on the login screen.',
    );
  });

  it('classifies flows by name, deterministically', () => {
    seedSuite();
    const kinds = Object.fromEntries(scan().flows.map((f) => [f.id, f.kind]));
    expect(kinds['login.loginFlow']).toBe('auth');
    expect(kinds['badge-creation.navigateToBadges']).toBe('navigate');
    expect(kinds['badge-creation.createBadge']).toBe('create');
  });

  it('records params and return type as written', () => {
    seedSuite();
    const create = scan().flows.find((f) => f.id === 'badge-creation.createBadge');
    expect(create?.returns).toBe('Promise<string>');
    expect(create?.params.map((p) => `${p.name}: ${p.type}`)).toEqual([
      'engine: Bubblegum',
      'page: Page',
    ]);
  });
});

describe('scanManifest — phrases', () => {
  it('captures act and verify strings in source order', () => {
    seedSuite();
    const login = scan().flows.find((f) => f.id === 'login.loginFlow');
    expect(login?.phrases).toEqual([
      'Enter "${credentials.username}" into Username',
      'Click Sign In',
      'the page header is "Dashboard"',
    ]);
  });

  it('keeps template holes rather than flattening them', () => {
    // `Enter "" into Username` would read as a bug in the suite rather than a
    // parameterised phrase, and would teach the generator the wrong shape.
    seedSuite();
    const login = scan().flows.find((f) => f.id === 'login.loginFlow');
    expect(login?.phrases[0]).toContain('${credentials.username}');
  });
});

describe('scanManifest — usage', () => {
  it('attributes flows to tests that import them dynamically', () => {
    // The four-layer test template must use `await import(...)` so env vars load
    // first. A scanner that only read static imports would call every flow
    // unused and leave the reuse check with nothing.
    seedSuite();
    const flows = scan().flows;
    expect(flows.find((f) => f.id === 'login.loginFlow')?.usedBy).toEqual([
      'tests/badge-creation.test.mts',
    ]);
    expect(flows.find((f) => f.id === 'badge-creation.createBadge')?.usedBy).toEqual([
      'tests/badge-creation.test.mts',
    ]);
  });

  it('reports a flow no test imports', () => {
    seedSuite();
    expect(scan().flows.find((f) => f.id === 'login.logoutFlow')?.usedBy).toEqual([]);
  });

  it('also understands static imports', () => {
    write('e2e/flows/login.flow.ts', LOGIN_FLOW);
    write('e2e/tests/static.test.ts', `import { loginFlow } from '../flows/login.flow';`);
    expect(scan().flows.find((f) => f.id === 'login.loginFlow')?.usedBy).toEqual([
      'tests/static.test.ts',
    ]);
  });
});

describe('scanManifest — data, helpers, credentials, repositories', () => {
  it('lists data exports with their keys', () => {
    seedSuite();
    expect(scan().data).toEqual([
      {
        id: 'badge.badgeFormData',
        file: 'data/badge.data.ts',
        exportName: 'badgeFormData',
        domain: 'badge',
        keys: ['namePrefix', 'description'],
      },
    ]);
  });

  it('finds arrow-function helpers, which is how the shared wrappers are written', () => {
    seedSuite();
    expect(scan().helpers.map((h) => h.id)).toContain('actions.act');
  });

  it('finds credential getters outside the suite', () => {
    seedSuite();
    write(
      'packages/data/BAP.ts',
      `/** Badge admin */
       export function getBAPBadgeSupportCredentials() { return { username: '', password: '' }; }
       export function getBAPCredentials() { return { username: '', password: '' }; }
       export function notACredentialFn() {}`,
    );
    const creds = scan(['packages/data']).credentials;
    expect(creds.map((c) => c.getter)).toEqual([
      'getBAPBadgeSupportCredentials',
      'getBAPCredentials',
    ]);
    expect(creds[0]!.role).toBe('Badge admin');
  });

  it('finds repositories and their public methods', () => {
    seedSuite();
    write(
      'packages/utilities/repository/BadgeRepository.ts',
      `export class BadgeRepository {
         async cleanupBadgeByName(n: string) {}
         async seedBadge(n: string) {}
         private connect() {}
       }`,
    );
    const repos = scan(['packages/utilities']).repositories;
    expect(repos).toHaveLength(1);
    expect(repos[0]!.className).toBe('BadgeRepository');
    expect(repos[0]!.methods).toEqual(['cleanupBadgeByName', 'seedBadge']);
  });
});

describe('scanManifest — robustness', () => {
  it('produces a valid empty manifest for a greenfield project', () => {
    // The bootstrapping case: nothing built yet, so the first feature generates
    // everything including the login flow.
    const manifest = scan();
    expect(isEmptyManifest(manifest)).toBe(true);
    expect(manifest.flows).toEqual([]);
  });

  it('survives a suite directory that does not exist', () => {
    expect(() => scan()).not.toThrow();
  });

  it('does not choke on a file with a syntax error', () => {
    // Someone else's monorepo will not always compile, and an inventory is most
    // wanted exactly when the build is broken.
    seedSuite();
    write('e2e/flows/broken.flow.ts', 'export async function oops( {{{ ');
    expect(() => scan()).not.toThrow();
    expect(scan().flows.length).toBeGreaterThanOrEqual(4);
  });

  it('is deterministic — two scans of the same tree agree', () => {
    seedSuite();
    const a = scan();
    const b = scan();
    expect({ ...a, generatedAt: '' }).toEqual({ ...b, generatedAt: '' });
  });

  it('ignores node_modules', () => {
    seedSuite();
    write('e2e/node_modules/pkg/thing.flow.ts', `export function createThing() {}`);
    expect(scan().flows.map((f) => f.id)).not.toContain('thing.createThing');
  });
});

describe('flowKindOf', () => {
  it.each([
    ['loginFlow', 'auth'],
    ['logoutFlow', 'auth'],
    ['navigateToBadges', 'navigate'],
    ['goToDashboard', 'navigate'],
    ['createBadge', 'create'],
    ['addSession', 'create'],
    ['validateBadge', 'validate'],
    ['verifyStatus', 'validate'],
    ['cleanup', 'cleanup'],
    ['doSomethingOdd', 'other'],
  ])('%s -> %s', (name, kind) => {
    expect(flowKindOf(name)).toBe(kind);
  });
});

describe('roleFromGetter', () => {
  it('turns a getter name into a readable role', () => {
    expect(roleFromGetter('getBAPBadgeSupportCredentials')).toBe('BAP Badge Support');
    expect(roleFromGetter('getOPMSVAUserCredentials')).toBe('OPMSVA User');
  });

  it('is undefined when there is nothing left', () => {
    expect(roleFromGetter('getCredentials')).toBeUndefined();
  });
});

describe('scanManifest — a wrong path must not look like an empty suite', () => {
  // The failure this prevents: a mistyped `suiteDir` scans nothing and returns
  // a perfectly valid manifest full of zeros, indistinguishable from a new
  // project. Someone then reports "it generated nothing" and there is no
  // evidence either way.
  it('warns when suiteDir does not exist', () => {
    const warnings = scan().warnings;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toMatch(/suiteDir does not exist/);
  });

  it('names the resolved absolute path, not the relative one', () => {
    // `packages/web-tests/src/smart-tests` looks correct until you see what it
    // resolved against.
    expect(scan().warnings[0]!.file).toContain(root);
  });

  it('warns per missing --root', () => {
    seedSuite();
    const warnings = scan(['packages/data', 'packages/utilities']).warnings;
    expect(warnings).toHaveLength(2);
    expect(warnings.every((w) => w.message.includes('--root does not exist'))).toBe(true);
  });

  it('stays silent when every path exists', () => {
    seedSuite();
    expect(scan().warnings).toEqual([]);
  });
});

describe('scanManifest — the arrow-function shape', () => {
  // A real miss, caught against a production repo: twenty of twenty-four
  // repositories appeared to expose nothing but `getInstance`, and it was very
  // nearly reported as "this framework cannot seed test data". The methods were
  // there; they were written as class properties, which are not
  // MethodDeclarations. The same gap applied to flows, where a suite written in
  // the arrow style would have reported zero flows — telling the generator with
  // total confidence that there was nothing to reuse.
  it('finds flows written as exported const arrow functions', () => {
    write(
      'e2e/flows/arrow.flow.ts',
      `import { act } from '../helpers/actions';
       /** Creates a thing the arrow way. */
       export const createThing = async (engine: Bubblegum, page: Page): Promise<string> => {
         await act(engine, 'Click the Create button');
         return 'x';
       };`,
    );
    const flow = scan().flows.find((f) => f.id === 'arrow.createThing');
    expect(flow).toBeDefined();
    expect(flow!.kind).toBe('create');
    expect(flow!.summary).toBe('Creates a thing the arrow way.');
    expect(flow!.returns).toBe('Promise<string>');
    expect(flow!.params.map((p) => p.name)).toEqual(['engine', 'page']);
    expect(flow!.phrases).toEqual(['Click the Create button']);
  });

  it('finds repository methods written as class properties', () => {
    write(
      'packages/utilities/repository/RoadShowsRepository.ts',
      `export class RoadShowsRepository extends Repository {
         public static getInstance(): RoadShowsRepository { return this.instance; }
         deleteRoadshowByName = async (name: string): Promise<void> => {};
         seedRoadshow = async (n: string) => {};
         private secret = async () => {};
       }`,
    );
    const repo = scan(['packages/utilities']).repositories[0]!;
    expect(repo.methods).toEqual(['deleteRoadshowByName', 'getInstance', 'seedRoadshow']);
  });

  it('does not expose private class properties', () => {
    write(
      'packages/utilities/repository/R.ts',
      `export class XRepository { private hidden = async () => {}; }`,
    );
    expect(scan(['packages/utilities']).repositories[0]!.methods).toEqual([]);
  });

  it('finds credential getters written as arrow consts', () => {
    write(
      'packages/data/BAP.ts',
      `/** Badge admin */
       export const getBAPBadgeSupportCredentials = () => ({ username: '', password: '' });`,
    );
    expect(scan(['packages/data']).credentials.map((c) => c.getter)).toEqual([
      'getBAPBadgeSupportCredentials',
    ]);
  });

  it('keeps both shapes in one file without duplicating', () => {
    write(
      'e2e/flows/mixed.flow.ts',
      `export async function declared(): Promise<void> {}
       export const arrowed = async (): Promise<void> => {};
       const notExported = async () => {};`,
    );
    expect(
      scan()
        .flows.map((f) => f.id)
        .filter((id) => id.startsWith('mixed.')),
    ).toEqual(['mixed.arrowed', 'mixed.declared']);
  });
});

describe('flowKindOf — workflow transitions', () => {
  // `approveActivityByPM` landed in `other` against the real suite. Admin
  // portals are full of these, and they are the opposite of `create`: the
  // entity already exists and the state change is the entire point. Filed
  // under `create`, the planner would be offered an approval flow when it
  // asked how to make something.
  it.each([
    ['approveActivityByPM', 'transition'],
    ['rejectSubmission', 'transition'],
    ['publishWorkout', 'transition'],
    ['cancelRegistration', 'transition'],
    ['submitForApproval', 'transition'],
  ])('%s -> %s', (name, kind) => {
    expect(flowKindOf(name)).toBe(kind);
  });

  it('still reads plain submit/create as creation', () => {
    expect(flowKindOf('submitBadge')).toBe('create');
    expect(flowKindOf('createBadge')).toBe('create');
  });
});

describe('credential getters that break the naming convention', () => {
  // A real project has `getCustomerSupportLevel1()` next to
  // `getBAPCusCareCredentials()`, doing the same job. Missing it means the
  // generator invents a getter, or a roles.md entry naming the real one is
  // reported as a broken reference — a false negative is expensive here, while
  // a false positive is one extra name in a list.
  it('finds a getter named without the Credentials suffix', () => {
    write(
      'packages/data/BAP.ts',
      `/** Customer support, level 1 */
       export function getCustomerSupportLevel1() {
         return { username: 'cs1', password: 'secret' };
       }`,
    );
    const creds = scan(['packages/data']).credentials;
    expect(creds.map((c) => c.getter)).toEqual(['getCustomerSupportLevel1']);
    expect(creds[0]!.role).toBe('Customer support, level 1');
  });

  it('finds it through an environment-keyed lookup', () => {
    write(
      'packages/data/BAP.ts',
      `const byEnv = { CCSIT: { username: 'a', password: 'b' } };
       export function getCustomerSupportLevel1() { return byEnv[process.env.ENV]; }`,
    );
    expect(scan(['packages/data']).credentials.map((c) => c.getter)).toEqual([
      'getCustomerSupportLevel1',
    ]);
  });

  it('does not claim every getter in the file', () => {
    write(
      'packages/data/BAP.ts',
      `export function getEnvironmentName() { return 'CCSIT'; }
       export function getRetryCount() { return 3; }`,
    );
    expect(scan(['packages/data']).credentials).toEqual([]);
  });

  it('finds one by its declared return type, whatever it is called', () => {
    // The real BAP suite types its login flow `(engine, page, credentials:
    // LoginCredentials)`. A project that names the concept has already told us
    // which functions produce one, and the annotation is right there in the
    // syntax — no prefix convention required.
    write(
      'packages/data/BAP.ts',
      `import type { LoginCredentials } from './types';
       export function smokeVendorUser(): LoginCredentials {
         return CREDS.vendor;
       }`,
    );
    expect(scan(['packages/data']).credentials.map((c) => c.getter)).toEqual(['smokeVendorUser']);
  });

  it('sees through a Promise wrapper', () => {
    write(
      'packages/data/BAP.ts',
      `export async function vendorAdmin(): Promise<LoginCredentials> { return fetchCreds(); }`,
    );
    expect(scan(['packages/data']).credentials.map((c) => c.getter)).toEqual(['vendorAdmin']);
  });

  it('does not claim a flow just because credentials are a parameter', () => {
    // `loginFlow(engine, page, credentials: LoginCredentials): Promise<void>`
    // consumes credentials; it does not produce them.
    write(
      'packages/data/BAP.ts',
      `export async function loginFlow(page: Page, credentials: LoginCredentials): Promise<void> {
         await page.goto('/');
       }`,
    );
    expect(scan(['packages/data']).credentials).toEqual([]);
  });

  it('still requires a get-prefix, so a random object factory is not a credential', () => {
    write(
      'packages/data/BAP.ts',
      `export function buildLoginPayload() { return { username: 'a', password: 'b' }; }`,
    );
    expect(scan(['packages/data']).credentials).toEqual([]);
  });
});

describe('the scan remembers where it looked', () => {
  // `--root packages/utilities --root packages/data` was the difference between
  // 25 credential getters and zero on the real BAP suite. A flag that has to be
  // retyped on every command is a flag somebody eventually omits, and the run
  // that omits it does not fail — it writes a manifest missing everything the
  // planner needs.
  it('records the extra roots it was given, sorted', () => {
    write('packages/data/BAP.ts', `export function getAdminCredentials() { return { username: 'a', password: 'b' }; }`);
    expect(scan(['packages/utilities', 'packages/data']).roots).toEqual([
      'packages/data',
      'packages/utilities',
    ]);
  });

  it('records an empty list when it was given none', () => {
    expect(scan([]).roots).toEqual([]);
  });
});
