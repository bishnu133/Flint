import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve, basename } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  AppKnowledgeSchema,
  EntityDocSchema,
  GlossaryTermSchema,
  RoleDocSchema,
  type AppKnowledge,
  type EntityDoc,
  type GlossaryTerm,
  type RoleDoc,
} from '../schemas/kb-app.js';

/**
 * Reads `kb/app/` — the human-written half of the knowledge base.
 *
 * ```
 * kb/app/
 * ├── glossary.md        term -> definition
 * ├── roles.md           role -> credential getter
 * ├── rules.md           constraints, as prose
 * └── entities/
 *     └── gaq.md         states, and how a test reaches each one
 * ```
 *
 * Every file is optional and a malformed one is a warning, never an error.
 * That is deliberate: this knowledge is written by people, over time, while
 * they are trying to do something else. A reader that refused to run until
 * every file was perfect would ensure the files were never written at all.
 * Half a glossary is worth more than none.
 */

const APP_SUBDIR = 'app';
const ENTITIES_SUBDIR = 'entities';

export function appDir(projectRoot: string, kbDir: string): string {
  return isAbsolute(kbDir) ? join(kbDir, APP_SUBDIR) : resolve(projectRoot, kbDir, APP_SUBDIR);
}

export function readAppKnowledge(projectRoot: string, kbDir: string): AppKnowledge {
  const dir = appDir(projectRoot, kbDir);
  const warnings: Array<{ file: string; message: string }> = [];

  const entities = readEntities(dir, warnings);
  const roles = readList(join(dir, 'roles.md'), 'roles', RoleDocSchema, warnings);
  const glossary = readList(join(dir, 'glossary.md'), 'terms', GlossaryTermSchema, warnings);

  return AppKnowledgeSchema.parse({
    entities: entities.sort((a, b) => a.entity.localeCompare(b.entity)),
    roles: (roles as RoleDoc[]).sort((a, b) => a.id.localeCompare(b.id)),
    glossary: (glossary as GlossaryTerm[]).sort((a, b) => a.term.localeCompare(b.term)),
    rules: readRules(join(dir, 'rules.md'), warnings),
    warnings: warnings.sort(
      (a, b) => a.file.localeCompare(b.file) || a.message.localeCompare(b.message),
    ),
  });
}

function readEntities(
  dir: string,
  warnings: Array<{ file: string; message: string }>,
): EntityDoc[] {
  const entitiesDir = join(dir, ENTITIES_SUBDIR);
  if (!existsSync(entitiesDir)) return [];
  const out: EntityDoc[] = [];
  for (const name of readdirSync(entitiesDir).sort((a, b) => a.localeCompare(b))) {
    // `_`-prefixed files are documentation, matching the convention feature
    // specs and flow scripts already use.
    if (!name.endsWith('.md') || name.startsWith('_')) continue;
    const path = join(entitiesDir, name);
    try {
      const { frontmatter } = splitFrontmatter(readFileSync(path, 'utf8'));
      if (frontmatter === undefined) {
        warnings.push({ file: path, message: 'no frontmatter — skipped' });
        continue;
      }
      const raw = parseYaml(frontmatter) as Record<string, unknown>;
      // Default the id to the filename, so `gaq.md` needs no `entity:` line.
      // One less thing to get wrong, and one less thing to keep in sync.
      out.push(EntityDocSchema.parse({ entity: basename(name, '.md'), ...raw }));
    } catch (err) {
      warnings.push({ file: path, message: describe(err) });
    }
  }
  return out;
}

/**
 * A list document: frontmatter holding one array under a known key.
 *
 * `roles.md` and `glossary.md` have the same shape, so they share a reader.
 * Entries that fail validation are dropped with a warning rather than taking
 * the whole file down — one malformed role must not cost you the other twenty.
 */
function readList<T extends { parse: (v: unknown) => unknown }>(
  path: string,
  key: string,
  schema: T,
  warnings: Array<{ file: string; message: string }>,
): unknown[] {
  if (!existsSync(path)) return [];
  let raw: Record<string, unknown>;
  try {
    const { frontmatter } = splitFrontmatter(readFileSync(path, 'utf8'));
    if (frontmatter === undefined) {
      warnings.push({ file: path, message: 'no frontmatter — skipped' });
      return [];
    }
    raw = (parseYaml(frontmatter) ?? {}) as Record<string, unknown>;
  } catch (err) {
    warnings.push({ file: path, message: describe(err) });
    return [];
  }

  const items = raw[key];
  if (items === undefined) {
    warnings.push({ file: path, message: `frontmatter has no \`${key}:\` list` });
    return [];
  }
  if (!Array.isArray(items)) {
    warnings.push({ file: path, message: `\`${key}:\` must be a list` });
    return [];
  }

  const out: unknown[] = [];
  for (const [i, item] of items.entries()) {
    try {
      out.push(schema.parse(item));
    } catch (err) {
      warnings.push({ file: path, message: `${key}[${i}]: ${describe(err)}` });
    }
  }
  return out;
}

/** `rules.md` is prose: every markdown list item is one rule. */
function readRules(path: string, warnings: Array<{ file: string; message: string }>): string[] {
  if (!existsSync(path)) return [];
  try {
    const { body } = splitFrontmatter(readFileSync(path, 'utf8'));
    return body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^[-*]\s+/.test(line))
      .map((line) => line.replace(/^[-*]\s+/, '').trim())
      .filter((line) => line !== '');
  } catch (err) {
    warnings.push({ file: path, message: describe(err) });
    return [];
  }
}

/** Same frontmatter convention feature specs use. */
export function splitFrontmatter(source: string): { frontmatter?: string; body: string } {
  const normalized = source.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { body: normalized };
  const end = normalized.indexOf('\n---', 3);
  if (end === -1) return { body: normalized };
  const bodyStart = normalized.indexOf('\n', end + 1);
  return {
    frontmatter: normalized.slice(4, end),
    body: bodyStart === -1 ? '' : normalized.slice(bodyStart + 1),
  };
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    // zod errors are long and JSON-shaped; the first issue is the useful part.
    const issues = (err as { issues?: Array<{ path: unknown[]; message: string }> }).issues;
    if (issues !== undefined && issues.length > 0) {
      const first = issues[0]!;
      const where = first.path.length > 0 ? `${first.path.join('.')}: ` : '';
      return `${where}${first.message}`;
    }
    return err.message;
  }
  return String(err);
}
