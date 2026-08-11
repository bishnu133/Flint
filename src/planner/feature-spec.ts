import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { FeatureSpecFrontmatterSchema, type FeatureSpecFrontmatter } from '../schemas/kb.js';
import { ConfigError } from '../shared/errors.js';
import { formatZodError } from '../shared/zod-format.js';

/**
 * Feature-spec reader.
 *
 * A spec is `kb/features/<id>.md`: YAML frontmatter the pipeline reads, plus a
 * markdown body that is free prose for the planner. The frontmatter is the
 * machine-readable half — `pages:`/`flows:` steer which Screen Model pages get
 * into the prompt, `acceptanceCriteria` become the checklist the plan is scored
 * against, and `id` is the `@feature:<id>` tag that ties a test back here.
 *
 * Unlike flow scripts (whose frontmatter only needs `id`/`description`, so a
 * two-line reader suffices) this one carries arrays and needs real YAML.
 */

export const FEATURES_SUBDIR = 'features';

export interface FeatureSpec {
  frontmatter: FeatureSpecFrontmatter;
  /** Markdown below the frontmatter — prose for the planner, verbatim. */
  body: string;
  /** File the spec was read from, for error messages and provenance. */
  path: string;
}

/** Feature spec files in `<kbDir>/features`, sorted for determinism. */
export function discoverFeatureFiles(projectRoot: string, kbDir: string): string[] {
  const dir = featuresDir(projectRoot, kbDir);
  if (!existsSync(dir)) return [];
  return (
    readdirSync(dir)
      // `_`-prefixed files are documentation, matching the flow-script convention.
      .filter((name) => name.endsWith('.md') && !name.startsWith('_'))
      .sort((a, b) => a.localeCompare(b))
      .map((name) => join(dir, name))
  );
}

export function featuresDir(projectRoot: string, kbDir: string): string {
  return isAbsolute(kbDir)
    ? join(kbDir, FEATURES_SUBDIR)
    : resolve(projectRoot, kbDir, FEATURES_SUBDIR);
}

/**
 * Split and validate a spec.
 *
 * A spec with no frontmatter is an error rather than a default-filled guess:
 * without an `id` there is no feature tag, so nothing downstream could attach
 * coverage to it.
 */
export function parseFeatureSpec(source: string, path: string): FeatureSpec {
  const { frontmatterText, body } = split(source);
  if (frontmatterText === undefined) {
    throw new ConfigError(`Feature spec has no frontmatter: ${path}.`, {
      hint: 'Start the file with a --- block containing at least `id:` and `title:`.',
    });
  }

  let raw: unknown;
  try {
    raw = parseYaml(frontmatterText);
  } catch (err) {
    throw new ConfigError(`Feature spec frontmatter is not valid YAML: ${path}.`, {
      cause: err,
      hint: err instanceof Error ? err.message : undefined,
    });
  }

  const parsed = FeatureSpecFrontmatterSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new ConfigError(
      `Feature spec frontmatter failed validation (${path}):\n${formatZodError(parsed.error)}`,
      { hint: 'Fix the key named above. `id` must be kebab-case and `title` non-empty.' },
    );
  }

  return { frontmatter: parsed.data, body: body.trim(), path };
}

/** Read one spec by id, e.g. `flint plan checkout`. */
export function readFeatureSpec(
  projectRoot: string,
  kbDir: string,
  featureId: string,
): FeatureSpec {
  const direct = join(featuresDir(projectRoot, kbDir), `${featureId}.md`);
  if (existsSync(direct)) {
    return parseFeatureSpec(readFileSync(direct, 'utf8'), direct);
  }

  // The filename need not match the id — the frontmatter is authoritative.
  for (const path of discoverFeatureFiles(projectRoot, kbDir)) {
    const spec = parseFeatureSpec(readFileSync(path, 'utf8'), path);
    if (spec.frontmatter.id === featureId) return spec;
  }

  const available = listFeatureIds(projectRoot, kbDir);
  throw new ConfigError(`No feature spec with id "${featureId}".`, {
    hint:
      available.length === 0
        ? `Create one at ${join(kbDir, FEATURES_SUBDIR, `${featureId}.md`)}.`
        : `Available: ${available.join(', ')}`,
  });
}

/** Every readable spec, skipping none silently — a bad spec throws. */
export function readAllFeatureSpecs(projectRoot: string, kbDir: string): FeatureSpec[] {
  return discoverFeatureFiles(projectRoot, kbDir).map((path) =>
    parseFeatureSpec(readFileSync(path, 'utf8'), path),
  );
}

/**
 * Ids of specs that parse. Used only to build the "did you mean" list, so a
 * broken spec must not prevent the error message about a *different* spec.
 */
export function listFeatureIds(projectRoot: string, kbDir: string): string[] {
  const ids: string[] = [];
  for (const path of discoverFeatureFiles(projectRoot, kbDir)) {
    try {
      ids.push(parseFeatureSpec(readFileSync(path, 'utf8'), path).frontmatter.id);
    } catch {
      ids.push(`${basename(path, '.md')} (unreadable)`);
    }
  }
  return ids;
}

function split(source: string): { frontmatterText?: string; body: string } {
  const normalized = source.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { body: normalized };
  const end = normalized.indexOf('\n---', 3);
  if (end === -1) return { body: normalized };
  const bodyStart = normalized.indexOf('\n', end + 1);
  return {
    frontmatterText: normalized.slice(4, end),
    body: bodyStart === -1 ? '' : normalized.slice(bodyStart + 1),
  };
}
