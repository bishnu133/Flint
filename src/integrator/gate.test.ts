import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCompileGate } from './gate.js';
import type { WriteDecision } from './writer.js';

/**
 * The gate shells out to a real `tsc`, so these are slower than the rest of the
 * unit suite — but a gate that is only tested against a stub is a gate nobody
 * has actually seen reject anything.
 */

let projectRoot: string;
let suiteRoot: string;

const TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      skipLibCheck: true,
      noEmit: true,
    },
    include: ['**/*.ts'],
  },
  null,
  2,
);

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'flint-gate-test-'));
  suiteRoot = join(projectRoot, 'e2e');
  mkdirSync(suiteRoot, { recursive: true });
  writeFileSync(join(suiteRoot, 'tsconfig.json'), TSCONFIG, 'utf8');
});
afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

function decision(path: string, contents: string): WriteDecision {
  return { path, targetPath: path, outcome: 'created', contents };
}

describe('runCompileGate', () => {
  it('passes code that typechecks', () => {
    const result = runCompileGate({
      projectRoot,
      suiteRoot,
      decisions: [decision('pages/login.page.ts', 'export class LoginPage {\n  x = 1;\n}\n')],
      existingFiles: new Map(),
    });
    expect(result.ran).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  }, 60_000);

  it('rejects code that does not, and says where', () => {
    const result = runCompileGate({
      projectRoot,
      suiteRoot,
      decisions: [decision('pages/broken.page.ts', 'export const x: number = "not a number";\n')],
      existingFiles: new Map(),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/broken\.page\.ts/);
  }, 60_000);

  it('typechecks a spec against the page object it imports', () => {
    // The reason the gate copies the whole suite: a spec calling a method the
    // page object does not have must fail here, not at `playwright test` time.
    const result = runCompileGate({
      projectRoot,
      suiteRoot,
      decisions: [
        decision('pages/login.page.ts', 'export class LoginPage {\n  ok(): void {}\n}\n'),
        decision(
          'tests/login.spec.ts',
          `import { LoginPage } from '../pages/login.page';\nnew LoginPage().missing();\n`,
        ),
      ],
      existingFiles: new Map(),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/missing/);
  }, 60_000);

  it('sees files already in the suite, not just the pending ones', () => {
    const result = runCompileGate({
      projectRoot,
      suiteRoot,
      decisions: [
        decision(
          'tests/login.spec.ts',
          `import { helper } from '../support/helper';\nhelper(1);\n`,
        ),
      ],
      existingFiles: new Map([
        ['support/helper.ts', 'export function helper(n: string): void {\n  void n;\n}\n'],
      ]),
    });
    // helper takes a string; the pending spec passes a number.
    expect(result.ok).toBe(false);
  }, 60_000);

  it('leaves no scratch directory behind', () => {
    runCompileGate({
      projectRoot,
      suiteRoot,
      decisions: [decision('pages/a.page.ts', 'export const a = 1;\n')],
      existingFiles: new Map(),
    });
    expect(existsSync(join(projectRoot, '.flint', 'gate'))).toBe(false);
  }, 60_000);

  it('reports honestly when it could not run rather than claiming success', () => {
    rmSync(join(suiteRoot, 'tsconfig.json'));
    const result = runCompileGate({
      projectRoot,
      suiteRoot,
      decisions: [decision('pages/a.page.ts', 'export const a = 1;\n')],
      existingFiles: new Map(),
    });
    expect(result.ran).toBe(false);
    expect(result.skippedReason).toMatch(/no tsconfig/);
  });

  it('declines to run against a tsconfig it cannot relocate', () => {
    writeFileSync(
      join(suiteRoot, 'tsconfig.json'),
      JSON.stringify({ extends: '../tsconfig.base.json' }),
      'utf8',
    );
    const result = runCompileGate({
      projectRoot,
      suiteRoot,
      decisions: [decision('pages/a.page.ts', 'export const a = 1;\n')],
      existingFiles: new Map(),
    });
    expect(result.ran).toBe(false);
    expect(result.skippedReason).toMatch(/extends/);
  });

  it('does not blame the generated code for a suite whose deps are missing', () => {
    // A suite that never ran `npm install` cannot be typechecked. Reporting
    // that as "the generated code is wrong" would send the user hunting a bug
    // that is not there.
    writeFileSync(
      join(suiteRoot, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, types: ['@playwright/test'] },
        include: ['**/*.ts'],
      }),
      'utf8',
    );
    const result = runCompileGate({
      projectRoot,
      suiteRoot,
      decisions: [
        decision(
          'pages/a.page.ts',
          `import type { Page } from '@playwright/test';\nexport type P = Page;\n`,
        ),
      ],
      existingFiles: new Map(),
    });
    expect(result.ran).toBe(false);
    expect(result.skippedReason).toMatch(/dependencies are not installed/);
  }, 60_000);

  it('still blames the generated code for a broken relative import', () => {
    // The other side of that judgement: a relative import that resolves to
    // nothing is the emitter's fault, and must not be excused as environmental.
    const result = runCompileGate({
      projectRoot,
      suiteRoot,
      decisions: [
        decision('tests/a.spec.ts', `import { X } from '../pages/does-not-exist';\nvoid X;\n`),
      ],
      existingFiles: new Map(),
    });
    expect(result.ran).toBe(true);
    expect(result.ok).toBe(false);
  }, 60_000);

  it('can be turned off', () => {
    const result = runCompileGate({
      projectRoot,
      suiteRoot,
      decisions: [decision('pages/broken.page.ts', 'const x: number = "nope";\n')],
      existingFiles: new Map(),
      skip: true,
    });
    expect(result.ran).toBe(false);
    expect(result.skippedReason).toMatch(/--no-gate/);
  });
});
