import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, loadConfigFromPath, findConfigFile } from './load.js';
import { ConfigError } from '../shared/errors.js';

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
  dir = mkdtempSync(join(tmpdir(), 'testgen-config-'));
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
      expect(err.hint).toMatch(/testgen\.config\.ts/);
    }
  });

  it('finds a config file when present', () => {
    writeFileSync(join(dir, 'testgen.config.ts'), validConfigSource, 'utf8');
    expect(findConfigFile(dir)).toContain('testgen.config.ts');
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
});
