import type { BubblegumFlow, BubblegumSuite, BubblegumTest, ReusedCall } from './suite.js';
import type { Phrase } from './phrase.js';

/**
 * A Bubblegum suite, written out (B3).
 *
 * Every shape here is taken from the target suite's own files rather than
 * designed. That is not deference for its own sake — a generated file that
 * imports `{ act } from '../helpers/bubblegum'` when the project's helper is
 * `'../helpers/actions'` is broken in a way no unit test of ours would catch,
 * and a second house style living beside the first is a permanent tax on
 * everyone who reads the directory afterwards.
 *
 * What the real files establish:
 *
 * - **A test is a script, not a Playwright spec.** `npx tsx tests/X.test.mts`,
 *   with a `main()`, a `try/catch/finally`, and `runTest(ctx, id, title, fn)`
 *   from `../helpers/runner`. There is no `test()`, no `describe`, and — the
 *   part that matters most — no `test.fixme()`. The emit precedence still has
 *   three outcomes, so a non-live case is written as a real flow function with
 *   its `runTest` call commented out under a banner saying why. The work is
 *   preserved as code that compiles; only the invocation is disabled, and it
 *   cannot run by accident.
 * - **Imports are dynamic and deferred**, because `dotenv` has to load before
 *   any module that reads `process.env` at load time. Copying that ordering is
 *   not optional: a static import of the engine helper would break the run in a
 *   way that looks like a configuration problem.
 * - **`act(engine, phrase)`**, not `act(engine, page, phrase)`.
 * - **Flows take `(engine: Bubblegum, page: Page, ...)`** and import from
 *   `../helpers/actions`.
 * - **Data is a plain exported const object**, and flows interpolate it:
 *   `Enter "${ActivityConfigData.postalCode}" into Postal Code`.
 */

export interface RenderedFile {
  /** Path relative to the suite directory. */
  path: string;
  contents: string;
}

/** Where each layer lives, matching the four-layer directory the suite uses. */
const DIRS = { flows: 'flows', data: 'data', tests: 'tests' } as const;

export interface RenderOptions {
  /**
   * The suite root relative to the project, e.g.
   * `packages/web-tests/src/smart-tests`.
   *
   * Only the `Run:` line in the header needs it, and that line is not
   * decoration — it is the command somebody copies. Hardcoding the shape from
   * one project's file printed
   * `npx tsx src/smart-tests/tests/x.test.mts` for a suite that actually lives
   * four directories further in, and the copied command failed with
   * ERR_MODULE_NOT_FOUND. A path in a comment is as wrong as a path in an
   * import; it just fails later and looks like the reader's mistake.
   */
  suiteDir?: string;
}

export function renderSuite(suite: BubblegumSuite, options: RenderOptions = {}): RenderedFile[] {
  const files: RenderedFile[] = [
    { path: `${DIRS.flows}/${suite.featureId}.flow.ts`, contents: renderFlowFile(suite) },
    {
      path: `${DIRS.tests}/${suite.featureId}.test.mts`,
      contents: renderTestFile(suite, options.suiteDir),
    },
  ];
  const data = renderDataFile(suite);
  if (data !== undefined) {
    files.unshift({ path: `${DIRS.data}/${suite.featureId}.data.ts`, contents: data });
  }
  return files;
}

/** `vendor-admin-view-facilitators` -> `VendorAdminViewFacilitatorsData`. */
export function dataConstName(featureId: string): string {
  const pascal = featureId
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part !== '')
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join('');
  return `${/^[A-Za-z_$]/.test(pascal) ? pascal : `Feature${pascal}`}Data`;
}

// ---------------------------------------------------------------- data layer

function renderDataFile(suite: BubblegumSuite): string | undefined {
  const entries = collectData(suite);
  if (entries.length === 0) return undefined;

  return [
    '/**',
    ` * Test data for \`${suite.featureId}\` — the values the flows type and choose.`,
    ' *',
    ' * Lifted out of the flows so the same journey can be run against different',
    ' * data without editing a sentence.',
    ' */',
    `export const ${dataConstName(suite.featureId)} = {`,
    ...entries.map(([key, value]) => `  ${key}: ${quote(value)},`),
    '};',
    '',
  ].join('\n');
}

/**
 * Every literal the flows type or choose, keyed by what the sentence calls the
 * field. Sorted, so regenerating produces the same file.
 */
function collectData(suite: BubblegumSuite): Array<[string, string]> {
  const entries = new Map<string, string>();
  for (const flow of suite.flows) {
    for (const step of flow.steps) {
      if (step.kind !== 'act' || step.value === undefined) continue;
      entries.set(dataKey(step.label ?? 'value', entries), step.value);
    }
  }
  return [...entries].sort(([a], [b]) => a.localeCompare(b));
}

/** `Postal Code` -> `postalCode`, with a numeric suffix if that is taken. */
export function dataKey(label: string, taken: ReadonlyMap<string, unknown>): string {
  const camel = label
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part !== '')
    .map((part, index) =>
      index === 0 ? part.toLowerCase() : part[0]!.toUpperCase() + part.slice(1).toLowerCase(),
    )
    .join('');
  const base = /^[A-Za-z_$]/.test(camel) ? camel : `field${camel}`;
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}${n}`)) n += 1;
  return `${base}${n}`;
}

// ---------------------------------------------------------------- flow layer

function renderFlowFile(suite: BubblegumSuite): string {
  const usesData = collectData(suite).length > 0;
  const lines = [
    '/**',
    ` * ${suite.title} — the steps that drive the page.`,
    ' *',
    ' * Flows drive and tests assert, so nothing here checks anything: a flow that',
    " * asserted one feature's expectations could not be called by another.",
    ' */',
    "import type { Page } from '@playwright/test';",
    "import type { Bubblegum } from '@bubblegum-ai/node';",
    "import { act } from '../helpers/actions';",
  ];
  if (usesData) {
    lines.push(`import { ${dataConstName(suite.featureId)} } from '../data/${suite.featureId}.data';`);
  }
  lines.push('');

  const keys = new Map<string, string>();
  for (const [key, value] of collectData(suite)) keys.set(value, key);

  for (const flow of suite.flows) {
    lines.push(...renderFlow(flow, suite.featureId, keys), '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function renderFlow(
  flow: BubblegumFlow,
  featureId: string,
  keys: ReadonlyMap<string, string>,
): string[] {
  const body: string[] = [];
  for (const step of flow.steps) {
    if (step.kind === 'goto') {
      body.push(`  await page.goto('${step.url}', { waitUntil: 'domcontentloaded' });`);
      continue;
    }
    if (step.kind !== 'act') continue;

    body.push(`  await act(engine, ${actArgument(step, featureId, keys)});`);
  }

  return [
    '/**',
    ` * ${flow.summary}`,
    ' *',
    ` * Generated for plan case \`${flow.caseId}\`.`,
    ' */',
    `export async function ${flow.name}(engine: Bubblegum, page: Page): Promise<void> {`,
    ...body,
    "  await page.waitForLoadState('domcontentloaded');",
    '}',
  ];
}

/**
 * The sentence, with any literal replaced by a reference into the data file —
 * `Enter "${VendorAdminData.username}" into Username`, which is exactly how the
 * suite's own flows are written.
 */
function actArgument(
  step: Extract<Phrase, { kind: 'act' }>,
  featureId: string,
  keys: ReadonlyMap<string, string>,
): string {
  const key = step.value === undefined ? undefined : keys.get(step.value);
  if (key === undefined || step.value === undefined) return quote(step.text);

  const templated = step.text.replace(
    `"${step.value}"`,
    `"\${${dataConstName(featureId)}.${key}}"`,
  );
  return `\`${templated.replace(/`/g, '\\`')}\``;
}

// ---------------------------------------------------------------- test layer

function renderTestFile(suite: BubblegumSuite, suiteDir?: string): string {
  const runPath = `${suiteDir === undefined ? '' : `${suiteDir}/`}${DIRS.tests}/${suite.featureId}.test.mts`;
  const flowImports = new Map<string, Set<string>>();
  const getterImports = new Map<string, Set<string>>();

  for (const test of suite.tests) {
    for (const call of test.reuse) {
      const from = importSpecifier(call);
      flowImports.set(from, (flowImports.get(from) ?? new Set()).add(call.exportName));
    }
  }
  for (const { getter, importPath } of suite.credentialImports) {
    const from = credentialSpecifier(importPath);
    getterImports.set(from, (getterImports.get(from) ?? new Set()).add(getter));
  }

  const base = suite.baseUrlConstant;
  const ownFlows = suite.tests
    .map((test) => test.flow)
    .filter((name): name is string => name !== undefined);

  const lines = [
    '/**',
    ` * ${suite.title}`,
    ' *',
    ` * Run:  npx tsx ${runPath}`,
    ` * Debug: HEADLESS=false ENV=CCSIT npx tsx ${runPath}`,
    ' */',
    '',
    '// --- Load env FIRST, before any module that reads process.env at load time ---',
    "import dotenv from 'dotenv';",
    "dotenv.config({ path: '.env.bubblegum.local' });",
    '',
    "// Type-only imports (erased at compile time, don't trigger module evaluation)",
    "import type { EngineContext } from '../helpers/engine';",
    '',
    '// --- Dynamic imports: these modules now see the env vars (HEADLESS, ENV, etc.) ---',
    "const { initEngine, teardownEngine } = await import('../helpers/engine');",
    "const { runTest } = await import('../helpers/runner');",
    "const { verify } = await import('../helpers/actions');",
  ];

  if (base !== undefined) {
    lines.push(`const { ${base.name} } = await import('${crossPackageSpecifier(base.importPath)}');`);
  }
  for (const [from, names] of sorted(getterImports)) {
    lines.push(`const { ${[...names].sort().join(', ')} } = await import('${from}');`);
  }
  for (const [from, names] of sorted(flowImports)) {
    lines.push(`const { ${[...names].sort().join(', ')} } = await import('${from}');`);
  }
  if (ownFlows.length > 0) {
    lines.push(
      `const { ${[...new Set(ownFlows)].sort().join(', ')} } = await import('../flows/${suite.featureId}.flow');`,
    );
  }

  lines.push(
    '',
    'async function main() {',
    '  let ctx: EngineContext | null = null;',
    '',
    '  try {',
    '    ctx = await initEngine();',
    '    const { page, engine } = ctx;',
    '',
    `    await page.goto(${gotoTarget(suite.baseUrl, suite)}, { waitUntil: 'networkidle', timeout: 30000 });`,
    '',
  );

  const seenNotes = new Set<string>();
  for (const test of suite.tests) lines.push(...renderTest(test, seenNotes, suite), '');

  lines.push(
    '  } catch (error) {',
    "    console.error('Test setup failed:', error);",
    '    process.exitCode = 1;',
    '  } finally {',
    '    if (ctx) {',
    '      await teardownEngine(ctx);',
    '    }',
    '  }',
    '}',
    '',
    'main();',
    '',
  );
  return lines.join('\n');
}

function renderTest(test: BubblegumTest, seenNotes: Set<string>, suite: BubblegumSuite): string[] {
  const body: string[] = [];
  for (const url of test.goto) {
    // The test already opened the app before the first case. Repeating that
    // exact navigation inside a case adds a round trip and says nothing.
    if (url.replace(/\/$/, '') === suite.baseUrl.replace(/\/$/, '')) continue;
    body.push(`      await page.goto(${gotoTarget(url, suite)}, { waitUntil: 'domcontentloaded' });`);
  }
  for (const call of test.reuse) {
    body.push(`      await ${call.exportName}(engine, page${argsOf(call)});`);
  }
  if (test.flow !== undefined) body.push(`      await ${test.flow}(engine, page);`);
  for (const check of test.checks) {
    if (check.kind === 'verify') body.push(`      await verify(engine, ${quote(check.text)});`);
    if (check.kind === 'url') {
      body.push(`      // TODO: assert the URL is ${quote(check.expected)} — no expect() in this runner.`);
    }
  }

  const call = [
    `    await runTest(ctx, ${quote(test.caseId)}, ${quote(test.title)}, async () => {`,
    ...body,
    '    });',
  ];

  // A note that applies to every case is a fact about the run, not about this
  // test. Repeating it seven times buries the ones that differ.
  const notes = test.notes
    .filter((note) => !seenNotes.has(note))
    .map((note) => {
      seenNotes.add(note);
      return `    // ${note}`;
    });

  if (test.mode.kind === 'live') return [...notes, ...call];

  // No `test.fixme()` in a script runner, so the invocation is commented out
  // under a banner. The flow function is still written as real code — the work
  // survives for whoever unblocks it, and nothing can run by accident.
  const label = test.mode.kind === 'fixme' ? 'NOT RUNNABLE' : 'SKIPPED';
  return [
    ...notes,
    `    // ${'-'.repeat(66)}`,
    `    // ${label}: ${test.mode.reason}`,
    `    // ${'-'.repeat(66)}`,
    ...call.map((line) => `    // ${line.trim()}`),
  ];
}

/**
 * A navigation target, expressed the way the suite expresses it.
 *
 * With a base-url constant identified, the URL is written relative to it —
 * `` `${initialApplicationUri}/facilitators/list` `` — so the generated test
 * follows `ENV` like every hand-written one. Without one it falls back to the
 * literal, which is correct but pinned to the environment that was explored.
 */
function gotoTarget(url: string, suite: BubblegumSuite): string {
  const base = suite.baseUrlConstant;
  if (base === undefined) return quote(url);

  const trimmedBase = suite.baseUrl.replace(/\/$/, '');
  if (url === trimmedBase || url === `${trimmedBase}/`) return base.name;
  if (url.startsWith(`${trimmedBase}/`)) {
    return `\`\${${base.name}}${url.slice(trimmedBase.length)}\``;
  }
  // Outside the explored app: a literal is the honest answer, since the
  // constant demonstrably does not describe this address.
  return quote(url);
}

function argsOf(call: ReusedCall): string {
  return call.args.length === 0 ? '' : `, ${call.args.join(', ')}`;
}

/**
 * `flows/login.flow.ts` -> `../flows/login.flow`, because the emitted test sits
 * in `tests/` beside it and the suite's own imports carry no extension.
 */
function importSpecifier(call: ReusedCall): string {
  return `../${call.importPath.replace(/\.[cm]?tsx?$/, '')}`;
}

/**
 * A credential file lives outside the suite root — the manifest records it from
 * the project root (`packages/data/BAP.ts`) while the test imports it relative
 * to `src/smart-tests/tests`, which is four levels down in this layout.
 */
/**
 * Any project-root-relative path, as the emitted test must import it.
 *
 * Same four-level hop as the credential files: the manifest records paths from
 * the project root, the test sits in `<suite>/tests`.
 */
function crossPackageSpecifier(importPath: string): string {
  return credentialSpecifier(importPath);
}

function credentialSpecifier(importPath: string): string {
  const withoutExtension = importPath.replace(/\.[cm]?tsx?$/, '');
  const fromPackages = withoutExtension.replace(/^packages\//, '');
  return `../../../../${fromPackages}`;
}

function sorted(map: ReadonlyMap<string, Set<string>>): Array<[string, Set<string>]> {
  return [...map].sort(([a], [b]) => a.localeCompare(b));
}

/** Single-quoted, matching the suite's own style, with quotes escaped. */
function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}
