import { existsSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import {
  Node,
  Project,
  SyntaxKind,
  type CallExpression,
  type ClassDeclaration,
  type SourceFile,
} from 'ts-morph';
import type { z } from 'zod';
import type {
  DataFactorySchema,
  FixtureSchema,
  PageObjectMethodSchema,
  CoverageMap,
  PageObject,
  SpecFile,
  SuiteIndex,
} from '../schemas/suite-index.js';

// Derived here rather than exported from the LOCKED schema file, which Phase 2
// must not touch. Same types, no change to the frozen module.
type PageObjectMethod = z.infer<typeof PageObjectMethodSchema>;
type Fixture = z.infer<typeof FixtureSchema>;
type DataFactory = z.infer<typeof DataFactorySchema>;
import { silentLogger, type Logger } from '../shared/logger.js';
import { classify } from './managed.js';

/**
 * Static scan of an existing Playwright suite.
 *
 * Purely syntactic — no type resolution, no tsconfig, no program build. That is
 * what keeps a 50-file suite under the 10 s exit criterion, and it is also what
 * makes the scanner robust: a suite that does not compile still indexes.
 *
 * Extraction is best-effort by design. The master plan is explicit that suites
 * will not follow our conventions, so directory layout is a hint rather than a
 * requirement: anything exporting a class is treated as a page object, anything
 * calling `test(` is treated as a spec, and a file can be both.
 */

/** Calls whose string arguments are selectors worth recording. */
const SELECTOR_CALLS = new Set([
  'locator',
  'getByTestId',
  'getByRole',
  'getByLabel',
  'getByPlaceholder',
  'getByText',
  'getByTitle',
  'getByAltText',
  '$',
  '$$',
  'waitForSelector',
]);

/** Call names that declare a test. */
const TEST_CALLS = new Set(['test', 'it']);
/** Modifiers that still declare a test, e.g. `test.skip('...')`. */
const TEST_MODIFIERS = new Set(['only', 'skip', 'fixme', 'fail', 'serial', 'parallel']);
const DESCRIBE_CALLS = new Set(['describe', 'suite']);

export interface ScanOptions {
  /** Absolute project root; every reported path is relative to this. */
  projectRoot: string;
  /** Suite directory, absolute or relative to the project root. */
  suiteDir: string;
  logger?: Logger;
  /** Extra featureId -> testIds pairs from plan history (Phase 3 onward). */
  planHistory?: CoverageMap;
}

export interface ScanWarning {
  file: string;
  message: string;
}

export interface ScanResult {
  index: SuiteIndex;
  /** Files that could not be parsed, and why. Never throws on a bad file. */
  warnings: ScanWarning[];
  /** True when the suite directory does not exist at all. */
  suiteMissing: boolean;
}

export function scanSuite(options: ScanOptions): ScanResult {
  const logger = options.logger ?? silentLogger();
  const suiteRoot = resolve(options.projectRoot, options.suiteDir);
  const warnings: ScanWarning[] = [];

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    // No tsconfig, no lib files: this is a syntax pass, not a type check.
    compilerOptions: { allowJs: true, noResolve: true },
  });

  let sourceFiles: SourceFile[] = [];
  try {
    sourceFiles = project.addSourceFilesAtPaths([
      `${suiteRoot}/**/*.ts`,
      `${suiteRoot}/**/*.tsx`,
      `${suiteRoot}/**/*.js`,
      `!${suiteRoot}/**/node_modules/**`,
      `!${suiteRoot}/**/*.d.ts`,
    ]);
  } catch (err) {
    logger.warn({ suiteRoot, err }, 'index: suite directory could not be read');
  }

  const pageObjects: PageObject[] = [];
  const specs: SpecFile[] = [];
  const fixtures: Fixture[] = [];
  const dataFactories: DataFactory[] = [];
  const managedFiles: string[] = [];
  const handEditedFiles: string[] = [];
  const coverageMap: CoverageMap = {};

  // Stable order in, stable order out — the index is written to disk and
  // diffed, so scan order must not depend on the filesystem.
  const ordered = [...sourceFiles].sort((a, b) => a.getFilePath().localeCompare(b.getFilePath()));

  for (const sourceFile of ordered) {
    const absolute = sourceFile.getFilePath();
    const file = toPosix(relative(options.projectRoot, absolute));

    // Managed-marker classification reads the raw bytes: ts-morph normalises
    // whitespace in ways that would change the hash.
    try {
      const raw = readFileSync(absolute, 'utf8');
      const info = classify(raw);
      if (info.status === 'managed') managedFiles.push(file);
      if (info.status === 'hand-edited') handEditedFiles.push(file);
    } catch (err) {
      warnings.push({ file, message: describe(err) });
    }

    try {
      collectFromFile(sourceFile, file, {
        pageObjects,
        specs,
        fixtures,
        dataFactories,
        coverageMap,
      });
    } catch (err) {
      // A file we cannot parse is skipped and reported. One broken file in a
      // user's suite must never cost them the index of the other forty-nine.
      warnings.push({ file, message: describe(err) });
      logger.warn({ file, err: describe(err) }, 'index: skipping unparseable file');
    }
  }

  // Fold in plan history so coverage reflects features planned but whose tests
  // carry no tag yet.
  for (const [featureId, testIds] of Object.entries(options.planHistory ?? {})) {
    coverageMap[featureId] = unique([...(coverageMap[featureId] ?? []), ...testIds]);
  }

  return {
    index: {
      generatedAt: new Date().toISOString(),
      suiteDir: toPosix(relative(options.projectRoot, suiteRoot)) || '.',
      pageObjects: pageObjects.sort(byKey((p) => `${p.file}:${p.className}`)),
      specs: specs.sort(byKey((s) => s.file)),
      fixtures: fixtures.sort(byKey((f) => `${f.file}:${f.name}`)),
      dataFactories: dataFactories.sort(byKey((d) => `${d.file}:${d.name}`)),
      coverageMap: sortCoverage(coverageMap),
      managedFiles: managedFiles.sort(),
      handEditedFiles: handEditedFiles.sort(),
    },
    warnings,
    suiteMissing: sourceFiles.length === 0 && !existsDir(suiteRoot),
  };
}

interface Collectors {
  pageObjects: PageObject[];
  specs: SpecFile[];
  fixtures: Fixture[];
  dataFactories: DataFactory[];
  coverageMap: CoverageMap;
}

function collectFromFile(sourceFile: SourceFile, file: string, out: Collectors): void {
  const segments = file.split('/');

  // --- page objects: any exported class, wherever it lives ----------------
  for (const cls of sourceFile.getClasses()) {
    if (!cls.isExported()) continue;
    const className = cls.getName();
    if (className === undefined) continue;
    out.pageObjects.push(buildPageObject(cls, className, file));
  }

  // --- specs: any file that calls test( ------------------------------------
  const spec = buildSpec(sourceFile, file);
  if (spec !== undefined) {
    out.specs.push(spec);
    for (const { featureId, testId } of spec.tags.flatMap((t) => featureRefs(t, spec.testTitles))) {
      out.coverageMap[featureId] = unique([...(out.coverageMap[featureId] ?? []), testId]);
    }
  }

  // --- fixtures and data factories: directory decides, exports supply names -
  const inDir = (name: string): boolean => segments.includes(name);
  if (inDir('fixtures') || file.includes('.fixture.')) {
    for (const name of exportedNames(sourceFile)) out.fixtures.push({ name, file });
  }
  if (inDir('data') || inDir('factories') || file.includes('.factory.')) {
    for (const name of exportedNames(sourceFile)) out.dataFactories.push({ name, file });
  }
}

function buildPageObject(cls: ClassDeclaration, className: string, file: string): PageObject {
  const methods: PageObjectMethod[] = [];
  const all = new Set<string>();

  for (const method of cls.getMethods()) {
    const selectorsUsed = selectorsIn(method);
    for (const s of selectorsUsed) all.add(s);
    methods.push({ name: method.getName(), selectorsUsed });
  }

  // Selectors also live in constructors and property initialisers, which is
  // how most real page objects are written.
  for (const s of selectorsIn(cls)) all.add(s);

  return {
    className,
    file,
    methods: methods.sort(byKey((m) => m.name)),
    selectorsUsed: [...all].sort(),
  };
}

/** String literals passed to any known locator-producing call. */
function selectorsIn(node: Node): string[] {
  const found = new Set<string>();
  for (const call of node.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const name = calleeName(call);
    if (name === undefined || !SELECTOR_CALLS.has(name)) continue;
    const first = call.getArguments()[0];
    if (first !== undefined && Node.isStringLiteral(first)) found.add(first.getLiteralValue());
  }
  return [...found].sort();
}

function buildSpec(sourceFile: SourceFile, file: string): SpecFile | undefined {
  const testTitles: string[] = [];
  const tags = new Set<string>();
  let sawTest = false;

  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const name = calleeName(call);
    if (name === undefined) continue;

    const isTest = TEST_CALLS.has(name);
    const isDescribe = DESCRIBE_CALLS.has(name);
    if (!isTest && !isDescribe) continue;

    const title = firstStringArg(call);
    if (title === undefined) continue;

    if (isTest) {
      sawTest = true;
      testTitles.push(title);
    }
    // Tags come from titles (`test('x @flint @feature:a')`) and from the
    // options-object form (`test('x', { tag: ['@flint'] }, fn)`). Describe-level
    // tags count too — they apply to every test inside.
    for (const tag of tagsInTitle(title)) tags.add(tag);
    for (const tag of tagsInOptions(call)) tags.add(tag);
  }

  if (!sawTest) return undefined;
  return { file, testTitles, tags: [...tags].sort() };
}

/**
 * Resolve the callee to a bare name, seeing through Playwright's modifiers.
 * `test`, `test.only`, `test.describe.serial` all resolve to `test`/`describe`.
 */
function calleeName(call: CallExpression): string | undefined {
  const expression = call.getExpression();
  if (Node.isIdentifier(expression)) return expression.getText();
  if (!Node.isPropertyAccessExpression(expression)) return undefined;

  const property = expression.getName();
  // `test.describe(...)` — the meaningful name is the property.
  if (DESCRIBE_CALLS.has(property) || SELECTOR_CALLS.has(property)) return property;
  if (!TEST_MODIFIERS.has(property)) return undefined;

  // `test.only(...)` / `test.describe.serial(...)`: walk left past modifiers.
  let current: Node = expression.getExpression();
  while (Node.isPropertyAccessExpression(current)) {
    const name = current.getName();
    if (DESCRIBE_CALLS.has(name)) return name;
    if (!TEST_MODIFIERS.has(name)) break;
    current = current.getExpression();
  }
  return Node.isIdentifier(current) ? current.getText() : undefined;
}

function firstStringArg(call: CallExpression): string | undefined {
  const first = call.getArguments()[0];
  if (first === undefined) return undefined;
  if (Node.isStringLiteral(first)) return first.getLiteralValue();
  if (Node.isNoSubstitutionTemplateLiteral(first)) return first.getLiteralValue();
  return undefined;
}

/** `@flint`, `@feature:login-1`, `@smoke` … anywhere in a title. */
export function tagsInTitle(title: string): string[] {
  return [...title.matchAll(/@[\w:.\-/]+/g)].map((m) => m[0]);
}

/** Tags from the `{ tag: '@x' }` / `{ tag: ['@x'] }` options argument. */
function tagsInOptions(call: CallExpression): string[] {
  const out: string[] = [];
  for (const arg of call.getArguments().slice(1)) {
    if (!Node.isObjectLiteralExpression(arg)) continue;
    const property = arg.getProperty('tag');
    if (property === undefined || !Node.isPropertyAssignment(property)) continue;
    const value = property.getInitializer();
    if (value === undefined) continue;
    if (Node.isStringLiteral(value)) out.push(value.getLiteralValue());
    if (Node.isArrayLiteralExpression(value)) {
      for (const element of value.getElements()) {
        if (Node.isStringLiteral(element)) out.push(element.getLiteralValue());
      }
    }
  }
  return out;
}

/**
 * A `@feature:<id>` tag covers every test in the file it appears in. Test
 * identity is `<file>::<title>`, which is stable and human-readable.
 */
function featureRefs(
  tag: string,
  testTitles: string[],
): Array<{ featureId: string; testId: string }> {
  if (!tag.startsWith('@feature:')) return [];
  const featureId = tag.slice('@feature:'.length);
  if (featureId === '') return [];
  return testTitles.map((title) => ({ featureId, testId: title }));
}

/** Names exported by a file, however they are exported. */
function exportedNames(sourceFile: SourceFile): string[] {
  const names = new Set<string>();
  for (const [name, declarations] of sourceFile.getExportedDeclarations()) {
    if (declarations.length > 0) names.add(name);
  }
  return [...names].sort();
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function sortCoverage(map: CoverageMap): CoverageMap {
  const out: CoverageMap = {};
  for (const key of Object.keys(map).sort()) out[key] = unique(map[key] ?? []);
  return out;
}

function byKey<T>(key: (item: T) => string): (a: T, b: T) => number {
  return (a, b) => key(a).localeCompare(key(b));
}

function toPosix(path: string): string {
  return sep === '\\' ? path.split(sep).join('/') : path;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function existsDir(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}
