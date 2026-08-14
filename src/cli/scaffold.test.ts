import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planScaffold, detectConflicts, applyScaffold, substitute } from './scaffold.js';
import { templatesDir } from '../shared/paths.js';

const initRoot = join(templatesDir(), 'init');

let target: string;

beforeEach(() => {
  target = mkdtempSync(join(tmpdir(), 'flint-init-'));
});

afterEach(() => {
  rmSync(target, { recursive: true, force: true });
});

describe('substitute', () => {
  it('replaces known placeholders and leaves unknown ones intact', () => {
    expect(substitute('a={{x}} b={{y}}', { x: '1' })).toBe('a=1 b={{y}}');
  });
});

describe('planScaffold', () => {
  it('enumerates the init template files deterministically', () => {
    const plan = planScaffold(initRoot);
    const rels = plan.map((f) => f.rel);
    expect(rels).toContain('flint.config.ts');
    // `_`-prefixed: the reader skips it, so a brand-new project does not spend
    // a planner call on the shipped example before anyone has written a spec.
    expect(rels).toContain(join('kb', 'features', '_example.md'));
    expect(rels).toContain(join('e2e', 'playwright.config.ts'));
    // Dotted on the way out — npm renames `.gitignore` inside a published
    // package, so the template is stored undotted.
    expect(rels).toContain('.gitignore');
    expect(rels).not.toContain('gitignore');
    // The suite needs its own manifest: `@playwright/test` is not a Flint
    // dependency, and without this `npm install` in e2e/ installs nothing, so
    // the compile gate cannot run and no test can execute.
    expect(rels).toContain(join('e2e', 'package.json'));
    // deterministic ordering
    expect([...rels]).toEqual([...rels].sort((a, b) => a.localeCompare(b)));
  });
});

describe('applyScaffold (never clobber)', () => {
  it('creates a full project with substitutions applied', () => {
    const plan = planScaffold(initRoot);
    const result = applyScaffold(
      target,
      plan,
      { baseUrl: 'https://demo.test', projectName: 'demo' },
      { overwrite: false },
    );
    expect(result.written.length).toBeGreaterThan(0);
    expect(result.skipped).toHaveLength(0);
    const config = readFileSync(join(target, 'flint.config.ts'), 'utf8');
    expect(config).toContain('https://demo.test');
    expect(config).not.toContain('{{baseUrl}}');
    expect(existsSync(join(target, 'e2e', 'pages', '.gitkeep'))).toBe(true);
  });

  it('skips existing files when overwrite is false (re-run case)', () => {
    const plan = planScaffold(initRoot);
    applyScaffold(
      target,
      plan,
      { baseUrl: 'https://a.test', projectName: 'demo' },
      {
        overwrite: false,
      },
    );
    const conflicts = detectConflicts(target, plan);
    expect(conflicts.length).toBe(plan.length);

    // Second run with overwrite=false must not touch existing files.
    const rerun = applyScaffold(
      target,
      plan,
      { baseUrl: 'https://CHANGED.test', projectName: 'x' },
      {
        overwrite: false,
      },
    );
    expect(rerun.written).toHaveLength(0);
    expect(rerun.skipped.length).toBe(plan.length);
    const config = readFileSync(join(target, 'flint.config.ts'), 'utf8');
    expect(config).toContain('https://a.test'); // unchanged
  });

  it('overwrites when overwrite is true', () => {
    const plan = planScaffold(initRoot);
    applyScaffold(
      target,
      plan,
      { baseUrl: 'https://a.test', projectName: 'demo' },
      {
        overwrite: false,
      },
    );
    applyScaffold(
      target,
      plan,
      { baseUrl: 'https://b.test', projectName: 'demo' },
      {
        overwrite: true,
      },
    );
    const config = readFileSync(join(target, 'flint.config.ts'), 'utf8');
    expect(config).toContain('https://b.test');
  });
});
