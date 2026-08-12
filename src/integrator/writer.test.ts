import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { applyWrites, formatWritePlan, planWrites, siblingPath } from './writer.js';
import { classify, withMarker } from '../indexer/managed.js';
import type { EmittedFile } from '../generator/emitter.js';

let suiteRoot: string;

beforeEach(() => {
  suiteRoot = mkdtempSync(join(tmpdir(), 'flint-writer-'));
});
afterEach(() => rmSync(suiteRoot, { recursive: true, force: true }));

const FILE: EmittedFile = {
  path: 'pages/login.page.ts',
  contents: 'export class LoginPage {}\n',
  kind: 'page-object',
};

function existing(path: string, contents: string): void {
  const absolute = join(suiteRoot, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents, 'utf8');
}

function read(path: string): string {
  return readFileSync(join(suiteRoot, path), 'utf8');
}

describe('planWrites', () => {
  it('creates a file that does not exist yet, stamped as managed', () => {
    const [decision] = planWrites({ suiteRoot, files: [FILE] });
    expect(decision?.outcome).toBe('created');
    expect(classify(decision!.contents).status).toBe('managed');
  });

  it('updates a managed file nobody has touched', () => {
    existing(FILE.path, withMarker('export class LoginPage { old = true; }\n'));
    expect(planWrites({ suiteRoot, files: [FILE] })[0]?.outcome).toBe('updated');
  });

  it('reports byte-identical output as unchanged rather than rewriting it', () => {
    // This is what makes the determinism guarantee visible in git: regenerating
    // an untouched feature must leave the working tree clean.
    existing(FILE.path, withMarker(FILE.contents));
    expect(planWrites({ suiteRoot, files: [FILE] })[0]?.outcome).toBe('unchanged');
  });

  it('diverts rather than overwriting a file a human has edited', () => {
    // The marker says Flint wrote it, but the hash no longer matches.
    existing(FILE.path, `${withMarker('export class LoginPage {}\n')}\n// my edit\n`);
    const [decision] = planWrites({ suiteRoot, files: [FILE] });
    expect(decision?.outcome).toBe('diverted');
    expect(decision?.targetPath).toBe('pages/login.page.flint.ts');
    expect(decision?.reason).toMatch(/edited by hand/);
  });

  it('never touches a hand-written file that has no marker at all', () => {
    existing(FILE.path, 'export class LoginPage { /* mine */ }\n');
    const [decision] = planWrites({ suiteRoot, files: [FILE] });
    expect(decision?.outcome).toBe('diverted');
    expect(decision?.reason).toMatch(/hand-written/);
  });

  it('touches nothing on disk', () => {
    planWrites({ suiteRoot, files: [FILE] });
    expect(() => read(FILE.path)).toThrow();
  });
});

describe('applyWrites', () => {
  it('writes new files, creating directories', () => {
    const result = applyWrites(suiteRoot, planWrites({ suiteRoot, files: [FILE] }));
    expect(result.written).toBe(1);
    expect(read(FILE.path)).toContain('export class LoginPage {}');
  });

  it('leaves a hand-edited file exactly as the human left it', () => {
    const mine = `${withMarker('export class LoginPage {}\n')}\n// my edit\n`;
    existing(FILE.path, mine);
    const result = applyWrites(suiteRoot, planWrites({ suiteRoot, files: [FILE] }));

    expect(read(FILE.path)).toBe(mine);
    expect(read('pages/login.page.flint.ts')).toContain('export class LoginPage {}');
    expect(result.diverted).toHaveLength(1);
  });

  it('skips unchanged files, so nothing is rewritten needlessly', () => {
    existing(FILE.path, withMarker(FILE.contents));
    expect(applyWrites(suiteRoot, planWrites({ suiteRoot, files: [FILE] })).written).toBe(0);
  });

  it('round-trips: writing then re-planning reports unchanged', () => {
    applyWrites(suiteRoot, planWrites({ suiteRoot, files: [FILE] }));
    expect(planWrites({ suiteRoot, files: [FILE] })[0]?.outcome).toBe('unchanged');
  });
});

describe('siblingPath', () => {
  it('inserts .flint before the extension', () => {
    expect(siblingPath('pages/login.page.ts')).toBe('pages/login.page.flint.ts');
    expect(siblingPath('tests/login.spec.ts')).toBe('tests/login.spec.flint.ts');
  });
});

describe('formatWritePlan', () => {
  it('says what will happen to each path', () => {
    existing('tests/login.spec.ts', 'hand written\n');
    const text = formatWritePlan(
      planWrites({
        suiteRoot,
        files: [FILE, { path: 'tests/login.spec.ts', contents: 'x\n', kind: 'spec' }],
      }),
      'e2e',
    );
    expect(text).toContain('create  e2e/pages/login.page.ts');
    expect(text).toContain('DIVERT  e2e/tests/login.spec.flint.ts');
    expect(text).toContain('is untouched');
  });

  it('says so plainly when there is nothing to do', () => {
    expect(formatWritePlan([], 'e2e')).toBe('Nothing to write.');
  });
});
