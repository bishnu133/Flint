import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createJiti } from 'jiti';
import { ConfigError } from '../shared/errors.js';
import { formatZodError, firstBadKey } from '../shared/zod-format.js';
import { TestGenConfigSchema, type TestGenConfig } from '../schemas/config.js';

const CONFIG_FILENAMES = ['testgen.config.ts', 'testgen.config.js', 'testgen.config.mjs'];

/** Locate the config file in `cwd`, or return undefined if none exists. */
export function findConfigFile(cwd: string): string | undefined {
  for (const name of CONFIG_FILENAMES) {
    const candidate = join(cwd, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Load and validate a `testgen.config.ts` from `cwd`.
 *
 * A TypeScript config is transpiled on the fly with jiti, so users write plain
 * TS. Validation failures raise a {@link ConfigError} whose message names every
 * bad key (via {@link formatZodError}) — never a raw stack trace.
 */
export async function loadConfig(cwd: string = process.cwd()): Promise<{
  config: TestGenConfig;
  path: string;
}> {
  const path = findConfigFile(cwd);
  if (path === undefined) {
    throw new ConfigError(`No testgen config found in ${cwd}.`, {
      hint: `Create a testgen.config.ts (run \`testgen init\`). Looked for: ${CONFIG_FILENAMES.join(', ')}`,
    });
  }
  return loadConfigFromPath(path);
}

/** Load and validate a config from a specific file path. */
export async function loadConfigFromPath(path: string): Promise<{
  config: TestGenConfig;
  path: string;
}> {
  const absPath = isAbsolute(path) ? path : join(process.cwd(), path);
  if (!existsSync(absPath)) {
    throw new ConfigError(`Config file not found: ${absPath}.`);
  }

  let mod: unknown;
  try {
    const jiti = createJiti(import.meta.url);
    mod = await jiti.import(absPath);
  } catch (err) {
    throw new ConfigError(`Failed to load config file: ${absPath}.`, {
      cause: err,
      hint: err instanceof Error ? err.message : undefined,
    });
  }

  const value = extractDefault(mod);
  const parsed = TestGenConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new ConfigError(`Invalid testgen config (${absPath}):\n${formatZodError(parsed.error)}`, {
      hint: `Fix the "${firstBadKey(parsed.error)}" key.`,
    });
  }
  return { config: parsed.data, path: absPath };
}

function extractDefault(mod: unknown): unknown {
  if (mod !== null && typeof mod === 'object' && 'default' in mod) {
    return (mod as { default: unknown }).default;
  }
  return mod;
}
