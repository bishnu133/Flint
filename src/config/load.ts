import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createJiti } from 'jiti';
import { ConfigError } from '../shared/errors.js';
import { formatZodError, firstBadKey } from '../shared/zod-format.js';
import { FlintConfigSchema, type FlintConfig } from '../schemas/config.js';

const CONFIG_FILENAMES = ['flint.config.ts', 'flint.config.js', 'flint.config.mjs'];

/** Locate the config file in `cwd`, or return undefined if none exists. */
export function findConfigFile(cwd: string): string | undefined {
  for (const name of CONFIG_FILENAMES) {
    const candidate = join(cwd, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Load and validate a `flint.config.ts` from `cwd`.
 *
 * A TypeScript config is transpiled on the fly with jiti, so users write plain
 * TS. Validation failures raise a {@link ConfigError} whose message names every
 * bad key (via {@link formatZodError}) — never a raw stack trace.
 */
export async function loadConfig(cwd: string = process.cwd()): Promise<{
  config: FlintConfig;
  path: string;
}> {
  const path = findConfigFile(cwd);
  if (path === undefined) {
    throw new ConfigError(`No flint config found in ${cwd}.`, {
      // Two causes, and the wrong-directory one is the likelier: Flint's own
      // checkout has no config, so every command run from there lands here.
      // Naming only `flint init` sends someone to scaffold a second project
      // they did not want.
      hint:
        `Point at an existing project with \`--dir <path>\`, or run \`flint init\` to ` +
        `create one here. Looked for: ${CONFIG_FILENAMES.join(', ')}`,
    });
  }
  return loadConfigFromPath(path);
}

/** Load and validate a config from a specific file path. */
export async function loadConfigFromPath(path: string): Promise<{
  config: FlintConfig;
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
  const parsed = FlintConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new ConfigError(`Invalid flint config (${absPath}):\n${formatZodError(parsed.error)}`, {
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
