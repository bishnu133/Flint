import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { createJiti } from 'jiti';
import type { BrowserContext, Page as PwPage } from '@playwright/test';
import type { FlintConfig } from '../schemas/config.js';
import type { Page, ScreenModel } from '../schemas/screen-model.js';
import { FlintError } from '../shared/errors.js';
import { silentLogger, type Logger } from '../shared/logger.js';
import { extractPage } from './extractor.js';
import { normalizePath, policyFromConfig } from './url-policy.js';
import { waitForDomStable } from './wait.js';

/**
 * Flow-script replay for hard-to-reach states.
 *
 * A BFS crawl only sees what a link takes it to. The order-review screen with
 * a populated cart, the third step of a wizard, an error banner after a bad
 * submit — none of those have a URL you can `goto`. A flow script is the
 * escape hatch: a short piece of user-written Playwright that drives the app
 * into such a state and tells Flint when to snapshot.
 *
 * Flows live in `<kbDir>/app/flows/*.md` so they sit beside the prose that
 * explains them, and so the knowledge base stays the one place a human edits.
 *
 * ```md
 * ---
 * id: checkout-review
 * description: Reach order review with one item in the cart
 * ---
 *
 * Prose for humans lives here and is ignored by the loader.
 *
 * ```ts
 * export default async (page, flint) => {
 *   await page.goto(flint.baseUrl + '/inventory.html');
 *   await page.click('[data-test="add-to-cart-backpack"]');
 *   await flint.capture('cart-populated');
 * };
 * ```
 * ```
 */

/** What a flow's default export receives. */
export interface FlowContext {
  /** `config.baseUrl`, so scripts need not hardcode an environment. */
  baseUrl: string;
  /** Snapshot the current page into the Screen Model. */
  capture(label?: string): Promise<void>;
}

export type FlowFunction = (page: PwPage, flint: FlowContext) => Promise<void>;

export interface FlowDefinition {
  id: string;
  description?: string;
  /** File the flow was read from, for error messages. */
  path: string;
  /** The extracted code block, before evaluation. */
  code: string;
}

/** Default location of flow scripts, relative to the knowledge-base dir. */
export const FLOWS_SUBDIR = join('app', 'flows');

/** Flow markdown files in `<kbDir>/app/flows`, sorted for determinism. */
export function discoverFlowFiles(projectRoot: string, kbDir: string): string[] {
  const dir = isAbsolute(kbDir)
    ? join(kbDir, FLOWS_SUBDIR)
    : resolve(projectRoot, kbDir, FLOWS_SUBDIR);
  if (!existsSync(dir)) return [];
  return (
    readdirSync(dir)
      // `_`-prefixed files are documentation, not flows. The shipped template is
      // `_example.md` for exactly this reason: a brand-new project must not
      // replay a placeholder script and report it as a failed flow.
      .filter((name) => name.endsWith('.md') && !name.startsWith('_'))
      .sort((a, b) => a.localeCompare(b))
      .map((name) => join(dir, name))
  );
}

const CODE_FENCE = /^```(ts|typescript|js|javascript)\s*$([\s\S]*?)^```\s*$/m;

/**
 * Pull the frontmatter and the first code fence out of a flow markdown file.
 *
 * Only the first fence is used: a flow is one script, and letting several
 * fences concatenate would make the execution order depend on prose layout.
 */
export function parseFlowMarkdown(
  source: string,
  fallbackId: string,
  path: string,
): FlowDefinition {
  const { frontmatter, body } = splitFrontmatter(source);
  const match = CODE_FENCE.exec(body);
  if (match === null) {
    throw new FlintError(`Flow file has no ts/js code block: ${path}.`, {
      code: 'CONFIG',
      hint: 'Add a ```ts fenced block exporting a default async (page, flint) => { ... } function.',
    });
  }
  const id = frontmatter.id ?? fallbackId;
  if (id.trim() === '') {
    throw new FlintError(`Flow file has an empty id: ${path}.`, {
      code: 'CONFIG',
      hint: 'Set `id:` in the frontmatter, or give the file a non-empty name.',
    });
  }
  return {
    id: id.trim(),
    path,
    code: match[2] ?? '',
    ...(frontmatter.description !== undefined ? { description: frontmatter.description } : {}),
  };
}

/**
 * Minimal frontmatter reader: `key: value` per line, between `---` markers.
 *
 * Deliberately not a YAML parser — flows only need `id` and `description`, and
 * a real parser would be a dependency plus a class of surprising failures for
 * a file humans hand-edit.
 */
function splitFrontmatter(source: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const normalized = source.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { frontmatter: {}, body: normalized };
  const end = normalized.indexOf('\n---', 3);
  if (end === -1) return { frontmatter: {}, body: normalized };

  const frontmatter: Record<string, string> = {};
  for (const line of normalized.slice(4, end).split('\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line
      .slice(colon + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    if (key !== '') frontmatter[key] = value;
  }
  const bodyStart = normalized.indexOf('\n', end + 1);
  return { frontmatter, body: bodyStart === -1 ? '' : normalized.slice(bodyStart + 1) };
}

/** Read and parse every flow file, in stable order. */
export function loadFlowDefinitions(projectRoot: string, kbDir: string): FlowDefinition[] {
  return discoverFlowFiles(projectRoot, kbDir).map((path) =>
    parseFlowMarkdown(readFileSync(path, 'utf8'), basename(path, '.md'), path),
  );
}

/** Evaluate a flow's code block into a callable function. */
export async function compileFlow(definition: FlowDefinition): Promise<FlowFunction> {
  let mod: unknown;
  try {
    const jiti = createJiti(import.meta.url);
    mod = await jiti.evalModule(definition.code, {
      // jiti requires an absolute filename; it is only used for stack traces,
      // so resolving a relative one keeps the error message useful either way.
      filename: resolve(definition.path),
      ext: '.ts',
      async: true,
    });
  } catch (err) {
    throw new FlintError(`Flow "${definition.id}" failed to compile.`, {
      code: 'CONFIG',
      cause: err,
      hint: `Check the code block in ${definition.path}. ${err instanceof Error ? err.message : ''}`.trim(),
    });
  }
  const fn = mod !== null && typeof mod === 'object' && 'default' in mod ? mod.default : mod;
  if (typeof fn !== 'function') {
    throw new FlintError(`Flow "${definition.id}" does not export a default function.`, {
      code: 'CONFIG',
      hint: `In ${definition.path}, write: export default async (page, flint) => { ... }`,
    });
  }
  return fn as FlowFunction;
}

export interface ReplayOptions {
  config: FlintConfig;
  projectRoot: string;
  logger?: Logger;
  /** Role tag, when exploring per-role. */
  role?: string;
  /** Replay only these flow ids; omitted = all. */
  only?: string[];
}

export interface FlowFailure {
  flowId: string;
  path: string;
  message: string;
}

export interface ReplayResult {
  pages: Page[];
  failures: FlowFailure[];
  /** Flows that ran without throwing, in replay order. */
  succeeded: string[];
}

/**
 * Replay every flow script and collect the pages they snapshot.
 *
 * One broken flow must not cost the user the others, so a throwing flow is
 * recorded as a failure and replay continues. Flows run in id order on their
 * own page, which keeps them independent of each other.
 */
export async function replayFlows(
  context: BrowserContext,
  options: ReplayOptions,
): Promise<ReplayResult> {
  const logger = options.logger ?? silentLogger();
  const { config } = options;
  const normalizeRules = policyFromConfig(config).normalize ?? [];

  const definitions = loadFlowDefinitions(options.projectRoot, config.kbDir).filter(
    (d) => options.only === undefined || options.only.includes(d.id),
  );

  const pages: Page[] = [];
  const failures: FlowFailure[] = [];
  const succeeded: string[] = [];

  for (const definition of definitions) {
    const page = await context.newPage();
    let step = 0;
    const flint: FlowContext = {
      baseUrl: config.baseUrl,
      capture: async (label?: string) => {
        await waitForDomStable(page);
        const captured = await extractPage(page, {
          i18n: config.explorer.i18n,
          normalizeRules,
          reachedVia: { kind: 'flow', flowId: definition.id, step },
          ...(options.role !== undefined ? { role: options.role } : {}),
        });
        pages.push(captured);
        logger.info(
          {
            flow: definition.id,
            step,
            label,
            url: captured.url,
            elements: captured.elements.length,
          },
          'flow captured a page',
        );
        step += 1;
      },
    };

    try {
      const fn = await compileFlow(definition);
      await fn(page, flint);
      // A flow that never calls capture() still meant to record where it
      // landed — snapshotting once is far more useful than silently nothing.
      if (step === 0) await flint.capture('end-of-flow');
      succeeded.push(definition.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ flowId: definition.id, path: definition.path, message });
      logger.warn({ flow: definition.id, err: message }, 'flow script failed');
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  return { pages, failures, succeeded };
}

/**
 * Fold flow-captured pages into a crawled model.
 *
 * A flow often lands on a URL the crawl already saw, in a different state —
 * the same cart page, now with items in it. Those are merged into one page by
 * id, taking the union of their elements, because the Screen Model keys pages
 * by normalized URL and V1 has no notion of per-state pages. The crawl's
 * `reachedVia` wins, since a plain navigation is the simpler way in.
 */
export function mergeFlowPages(model: ScreenModel, flowPages: Page[]): ScreenModel {
  const byId = new Map(model.pages.map((p) => [p.id, p]));

  for (const flowPage of flowPages) {
    const existing = byId.get(flowPage.id);
    if (existing === undefined) {
      byId.set(flowPage.id, flowPage);
      continue;
    }
    const seen = new Set(existing.elements.map((e) => e.id));
    const added = flowPage.elements.filter((e) => !seen.has(e.id));
    byId.set(flowPage.id, {
      ...existing,
      elements: [...existing.elements, ...added],
      navTargets: [...new Set([...existing.navTargets, ...flowPage.navTargets])].sort((a, b) =>
        a.localeCompare(b),
      ),
    });
  }

  return {
    ...model,
    pages: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/** Human-readable replay summary for the CLI. */
export function formatReplay(result: ReplayResult): string {
  const lines = [`Flows replayed: ${result.succeeded.length}`];
  if (result.pages.length > 0) lines.push(`  pages captured: ${result.pages.length}`);
  if (result.failures.length > 0) {
    lines.push(`  failed: ${result.failures.length}`);
    for (const failure of result.failures) {
      lines.push(`  ! ${failure.flowId} (${failure.path})`);
      lines.push(`      ${failure.message}`);
    }
  }
  return lines.join('\n');
}

/** Resolve `normalizePath` for callers that only have a URL. Re-exported for tests. */
export { normalizePath };
