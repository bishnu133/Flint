import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTemplate, renderTemplate, loadAndRender } from './template-loader.js';
import { promptsDir } from '../shared/paths.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'testgen-templates-'));
  writeFileSync(
    join(dir, 'good.md'),
    '<!-- version: 2 -->\nHello {{name}}, welcome to {{tool}}.\n',
    'utf8',
  );
  writeFileSync(join(dir, 'noversion.md'), 'Hello {{name}}\n', 'utf8');
  writeFileSync(join(dir, 'missing.md'), '<!-- version: 1 -->\nHi {{who}}\n', 'utf8');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadTemplate', () => {
  it('parses the version header and strips it from the body', () => {
    const t = loadTemplate('good', dir);
    expect(t.version).toBe('2');
    expect(t.body.startsWith('Hello')).toBe(true);
  });

  it('throws naming the file when the template does not exist', () => {
    expect(() => loadTemplate('nope', dir)).toThrow(/not found/);
  });

  it('throws when the version header is missing', () => {
    expect(() => loadTemplate('noversion', dir)).toThrow(/missing its version header/);
  });
});

describe('renderTemplate', () => {
  it('substitutes all placeholders', () => {
    const t = loadTemplate('good', dir);
    expect(renderTemplate(t, { name: 'Ada', tool: 'TestGen' })).toBe(
      'Hello Ada, welcome to TestGen.\n',
    );
  });

  it('is a hard error when a placeholder value is missing, naming it', () => {
    const t = loadTemplate('missing', dir);
    expect(() => renderTemplate(t, {})).toThrow(/who/);
  });

  it('treats undefined/null values as missing', () => {
    const t = loadTemplate('missing', dir);
    expect(() => renderTemplate(t, { who: undefined as unknown as string })).toThrow(/who/);
  });
});

describe('shipped hello-llm template', () => {
  it('loads and renders from the real prompts dir', () => {
    const { text } = loadAndRender('hello-llm', { toolName: 'TestGen' }, promptsDir());
    expect(text).toMatch(/TestGen/);
  });
});
