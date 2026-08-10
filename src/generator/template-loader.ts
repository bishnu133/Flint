import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TemplateError } from '../shared/errors.js';
import { promptsDir } from '../shared/paths.js';

/**
 * Prompt template loader (master plan B1 / CLAUDE.md).
 *
 * Templates are versioned markdown files in `src/generator/prompts/`. Each file
 * MUST begin with a version header comment:
 *
 *   <!-- version: 1 -->
 *
 * Placeholders use `{{name}}` syntax. Rendering with a missing placeholder is a
 * HARD ERROR that names the placeholder — never a silent empty substitution.
 * Prompt strings are never inlined in code; they always come through here.
 */

export interface PromptTemplate {
  name: string;
  version: string;
  body: string;
  path: string;
}

const VERSION_HEADER = /^\s*<!--\s*version:\s*(.+?)\s*-->/;
const PLACEHOLDER = /\{\{\s*([\w.-]+)\s*\}\}/g;

/** Load a template by name (without extension) from the prompts directory. */
export function loadTemplate(name: string, dir: string = promptsDir()): PromptTemplate {
  const path = join(dir, `${name}.md`);
  if (!existsSync(path)) {
    throw new TemplateError(`Prompt template "${name}" not found.`, {
      hint: `Expected a markdown file at ${path}`,
    });
  }
  const raw = readFileSync(path, 'utf8');
  const match = VERSION_HEADER.exec(raw);
  if (match === null || match[1] === undefined) {
    throw new TemplateError(`Prompt template "${name}" is missing its version header.`, {
      hint: 'Add a header comment on the first line, e.g. `<!-- version: 1 -->`',
    });
  }
  const version = match[1];
  const body = raw.slice(match.index + match[0].length).replace(/^\r?\n/, '');
  return { name, version, body, path };
}

/**
 * Render a template's body, substituting every `{{placeholder}}`.
 *
 * Throws a {@link TemplateError} naming the first placeholder that has no
 * corresponding value. Values are stringified; `undefined`/`null` count as
 * missing.
 */
export function renderTemplate(
  template: PromptTemplate,
  vars: Record<string, string | number | boolean>,
): string {
  const missing = new Set<string>();
  const rendered = template.body.replace(PLACEHOLDER, (_full, key: string) => {
    const value = vars[key];
    if (value === undefined || value === null) {
      missing.add(key);
      return '';
    }
    return String(value);
  });
  if (missing.size > 0) {
    const names = [...missing].sort().join(', ');
    throw new TemplateError(
      `Missing value(s) for placeholder(s) in template "${template.name}": ${names}.`,
      { hint: `Provide these keys when rendering template "${template.name}".` },
    );
  }
  return rendered;
}

/** Convenience: load and render in one call. */
export function loadAndRender(
  name: string,
  vars: Record<string, string | number | boolean>,
  dir?: string,
): { template: PromptTemplate; text: string } {
  const template = loadTemplate(name, dir);
  return { template, text: renderTemplate(template, vars) };
}
