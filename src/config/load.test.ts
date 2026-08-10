import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, loadConfigFromPath, findConfigFile } from './load.js';
import { ConfigError } from '../shared/errors.js';
import { templatesDir } from '../shared/paths.js';
import { substitute } from '../cli/scaffold.js';

let dir: string;

const validConfigSource = `export default {
  baseUrl: 'https://app.example.com',
  envClass: 'test',
  models: { planner: 'a', coder: 'b', repair: 'c' },
};
`;

const invalidConfigSource = `export default {
  baseUrl: 'not-a-url',
  envClass: 'test',
  models: { planner: 'a', coder: 'b', repair: 'c' },
};
`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'flint-config-'));
  writeFileSync(join(dir, 'valid.config.ts'), validConfigSource, 'utf8');
  writeFileSync(join(dir, 'invalid.config.ts'), invalidConfigSource, 'utf8');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('throws a ConfigError naming the expected filenames when none exists', async () => {
    await expect(loadConfig(dir)).rejects.toThrowError(ConfigError);
    const err = await loadConfig(dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    if (err instanceof ConfigError) {
      expect(err.hint).toMatch(/flint\.config\.ts/);
    }
  });

  it('finds a config file when present', () => {
    writeFileSync(join(dir, 'flint.config.ts'), validConfigSource, 'utf8');
    expect(findConfigFile(dir)).toContain('flint.config.ts');
  });
});

describe('loadConfigFromPath', () => {
  it('loads and validates a well-formed TS config', async () => {
    const { config } = await loadConfigFromPath(join(dir, 'valid.config.ts'));
    expect(config.baseUrl).toBe('https://app.example.com');
    expect(config.dialect).toBe('playwright-pom'); // default applied
  });

  it('produces a friendly zod error naming the bad key (not a stack trace)', async () => {
    await expect(loadConfigFromPath(join(dir, 'invalid.config.ts'))).rejects.toThrowError(
      ConfigError,
    );
    await expect(loadConfigFromPath(join(dir, 'invalid.config.ts'))).rejects.toThrow(/baseUrl/);
  });

  it('loads the ACTUAL shipped init template even without flint installed locally', async () => {
    // The template uses a type-only import of 'flint', which is erased at
    // load time — so a freshly init-ed project must load fine before
    // `flint` exists in its node_modules.
    const raw = readFileSync(join(templatesDir(), 'init', 'flint.config.ts'), 'utf8');
    const substituted = substitute(raw, { baseUrl: 'https://www.saucedemo.com' });
    const file = join(dir, 'shipped-template.config.ts');
    writeFileSync(file, substituted, 'utf8');

    const { config } = await loadConfigFromPath(file);
    expect(config.baseUrl).toBe('https://www.saucedemo.com');
    expect(config.envClass).toBe('test');
    expect(config.models.planner).toBe('claude-opus-5');
  });
});
