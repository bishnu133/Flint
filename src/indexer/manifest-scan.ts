import { relative, resolve, basename } from 'node:path';
import {
  Project,
  SyntaxKind,
  type SourceFile,
  type FunctionDeclaration,
  type Node,
  type VariableStatement,
} from 'ts-morph';
import {
  SuiteManifestSchema,
  type CredentialEntry,
  type DataEntry,
  type FlowEntry,
  type FlowKind,
  type HelperEntry,
  type RepositoryEntry,
  type SuiteManifest,
} from '../schemas/manifest.js';
import { silentLogger, type Logger } from '../shared/logger.js';

/**
 * Builds the Suite Manifest by static scan (Bubblegum phase B1).
 *
 * A syntax pass, deliberately: no tsconfig, no type checker, no module
 * resolution. The suite being scanned belongs to somebody else and may not
 * compile — a monorepo with unresolved workspace imports is the normal case,
 * not the exception — and a scanner that needs a green build to produce an
 * inventory would be useless exactly when the inventory is most wanted.
 *
 * Nothing here calls a model. Every field is read from the source: names from
 * declarations, summaries from JSDoc, phrases from string literals. That keeps
 * the manifest free to regenerate, which is what lets it be regenerated on
 * every run rather than maintained.
 */

/** Calls whose first string argument is a Bubblegum intent. */
const PHRASE_CALLS = new Set(['act', 'verify', 'observe', 'preflight']);

export interface ManifestScanOptions {
  projectRoot: string;
  /** Suite directory holding `flows/`, `data/`, `tests/`, `helpers/`. */
  suiteDir: string;
  /**
   * Extra directories to scan for credential getters and repositories.
   *
   * In a monorepo these live outside the suite — `packages/data`,
   * `packages/utilities/repository` — and the generator has to name them
   * exactly, so they belong in the manifest even though they are not test code.
   */
  extraRoots?: string[];
  logger?: Logger;
}

export function scanManifest(options: ManifestScanOptions): SuiteManifest {
  const logger = options.logger ?? silentLogger();
  const suiteRoot = resolve(options.projectRoot, options.suiteDir);
  const warnings: Array<{ file: string; message: string }> = [];

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: { allowJs: true, noResolve: true },
  });

  const suiteFiles = addFiles(project, suiteRoot, logger, warnings);
  const extraFiles = (options.extraRoots ?? []).flatMap((root) =>
    addFiles(project, resolve(options.projectRoot, root), logger, warnings),
  );

  const rel = (file: SourceFile): string =>
    relative(suiteRoot, file.getFilePath()).split('\\').join('/');
  const relFromProject = (file: SourceFile): string =>
    relative(options.projectRoot, file.getFilePath()).split('\\').join('/');

  const flows: FlowEntry[] = [];
  const data: DataEntry[] = [];
  const helpers: HelperEntry[] = [];
  const credentials: CredentialEntry[] = [];
  const repositories: RepositoryEntry[] = [];

  for (const file of suiteFiles) {
    const path = rel(file);
    try {
      if (isFlowFile(path)) flows.push(...readFlows(file, path));
      else if (isDataFile(path)) data.push(...readData(file, path));
      else if (isHelperFile(path)) helpers.push(...readHelpers(file, path));
    } catch (err) {
      warnings.push({ file: path, message: describe(err) });
    }
  }

  for (const file of [...suiteFiles, ...extraFiles]) {
    const path = relFromProject(file);
    try {
      credentials.push(...readCredentials(file, path));
      repositories.push(...readRepositories(file, path));
    } catch (err) {
      warnings.push({ file: path, message: describe(err) });
    }
  }

  attributeUsage(flows, suiteFiles, rel);

  const manifest: SuiteManifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    suiteDir: options.suiteDir,
    // Stable ordering throughout: the manifest is written to disk and diffed,
    // and it feeds a cached prompt. Order drift would invalidate both.
    flows: flows.sort(byId),
    data: data.sort(byId),
    helpers: helpers.sort(byId),
    credentials: credentials.sort((a, b) => a.getter.localeCompare(b.getter)),
    repositories: repositories.sort((a, b) => a.className.localeCompare(b.className)),
    warnings: warnings.sort(
      (a, b) => a.file.localeCompare(b.file) || a.message.localeCompare(b.message),
    ),
  };
  logger.info(
    {
      flows: manifest.flows.length,
      data: manifest.data.length,
      credentials: manifest.credentials.length,
      repositories: manifest.repositories.length,
      warnings: manifest.warnings.length,
    },
    'manifest: scanned',
  );
  return SuiteManifestSchema.parse(manifest);
}

function addFiles(
  project: Project,
  root: string,
  logger: Logger,
  warnings: Array<{ file: string; message: string }>,
): SourceFile[] {
  try {
    return project.addSourceFilesAtPaths([
      `${root}/**/*.ts`,
      `${root}/**/*.mts`,
      `${root}/**/*.cts`,
      `!${root}/**/node_modules/**`,
      `!${root}/**/*.d.ts`,
    ]);
  } catch (err) {
    logger.warn({ root, err }, 'manifest: directory could not be read');
    warnings.push({ file: root, message: describe(err) });
    return [];
  }
}

const byId = (a: { id: string }, b: { id: string }): number => a.id.localeCompare(b.id);

const isFlowFile = (path: string): boolean => /\.flow\.[cm]?ts$/.test(path);
const isDataFile = (path: string): boolean => /\.data\.[cm]?ts$/.test(path);
const isTestFile = (path: string): boolean => /\.(test|spec)\.[cm]?ts$/.test(path);
const isHelperFile = (path: string): boolean => path.startsWith('helpers/') && !isTestFile(path);

/** `flows/badge-creation.flow.ts` -> `badge-creation`. */
function domainOf(path: string): string {
  return basename(path).replace(/\.(flow|data)\.[cm]?ts$/, '');
}

/**
 * What a flow does, from its name.
 *
 * Deterministic on purpose. This drives which existing flows the planner is
 * shown for a given feature, and a model-inferred label would make that
 * selection vary between runs for no benefit.
 */
export function flowKindOf(name: string): FlowKind {
  if (/^(login|logout|signIn|signOut|authenticate)/i.test(name)) return 'auth';
  if (/^(navigate|goTo|open)/i.test(name)) return 'navigate';
  if (/^(create|add|submit|register)/i.test(name)) return 'create';
  if (/^(validate|verify|assert|check|expect)/i.test(name)) return 'validate';
  if (/^(cleanup|teardown|delete|remove|purge)/i.test(name)) return 'cleanup';
  return 'other';
}

function readFlows(file: SourceFile, path: string): FlowEntry[] {
  const domain = domainOf(path);
  const entries: FlowEntry[] = [];
  for (const fn of exportedFunctions(file)) {
    const name = fn.getName();
    if (name === undefined || name === '') continue;
    const summary = jsDocSummary(fn);
    entries.push({
      id: `${domain}.${name}`,
      file: path,
      exportName: name,
      domain,
      kind: flowKindOf(name),
      ...(summary !== undefined ? { summary } : {}),
      params: fn.getParameters().map((p) => ({
        name: p.getName(),
        type: p.getTypeNode()?.getText() ?? '',
      })),
      returns: fn.getReturnTypeNode()?.getText() ?? '',
      phrases: phrasesIn(fn),
      usedBy: [],
    });
  }
  return entries;
}

/** Exported `function` declarations, including `export async function`. */
function exportedFunctions(file: SourceFile): FunctionDeclaration[] {
  return file.getFunctions().filter((fn) => fn.isExported());
}

/**
 * The intent strings a function issues.
 *
 * Template literals keep their `${...}` holes rather than being flattened to
 * the literal text around them: `Enter "${value}" into Username` tells a reader
 * the value is a parameter, where `Enter "" into Username` would look like a
 * bug in the suite.
 */
function phrasesIn(node: Node): string[] {
  const found: string[] = [];
  for (const call of node.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    const name = callee.isKind(SyntaxKind.PropertyAccessExpression)
      ? callee.getName()
      : callee.getText();
    if (!PHRASE_CALLS.has(name)) continue;
    for (const arg of call.getArguments()) {
      const text = literalText(arg);
      if (text !== undefined) {
        found.push(text);
        break;
      }
    }
  }
  return found;
}

function literalText(node: Node): string | undefined {
  if (node.isKind(SyntaxKind.StringLiteral)) return node.getLiteralValue();
  if (node.isKind(SyntaxKind.NoSubstitutionTemplateLiteral)) return node.getLiteralValue();
  if (node.isKind(SyntaxKind.TemplateExpression)) {
    // Rebuild with the holes intact.
    let out = node.getHead().getLiteralText();
    for (const span of node.getTemplateSpans()) {
      out += `\${${span.getExpression().getText()}}`;
      out += span.getLiteral().getLiteralText();
    }
    return out;
  }
  return undefined;
}

function readData(file: SourceFile, path: string): DataEntry[] {
  const domain = domainOf(path);
  const entries: DataEntry[] = [];
  for (const statement of file.getVariableStatements()) {
    if (!statement.isExported()) continue;
    for (const decl of statement.getDeclarations()) {
      const init = decl.getInitializer();
      const keys =
        init !== undefined && init.isKind(SyntaxKind.ObjectLiteralExpression)
          ? init
              .getProperties()
              .map(propertyName)
              .filter((n): n is string => n !== undefined)
          : [];
      entries.push({
        id: `${domain}.${decl.getName()}`,
        file: path,
        exportName: decl.getName(),
        domain,
        keys,
      });
    }
  }
  return entries;
}

function propertyName(prop: Node): string | undefined {
  if (prop.isKind(SyntaxKind.PropertyAssignment)) return prop.getName();
  if (prop.isKind(SyntaxKind.ShorthandPropertyAssignment)) return prop.getName();
  return undefined;
}

function readHelpers(file: SourceFile, path: string): HelperEntry[] {
  const stem = basename(path).replace(/\.[cm]?ts$/, '');
  const entries: HelperEntry[] = [];
  for (const fn of exportedFunctions(file)) {
    const name = fn.getName();
    if (name === undefined || name === '') continue;
    const summary = jsDocSummary(fn);
    entries.push({
      id: `${stem}.${name}`,
      file: path,
      exportName: name,
      ...(summary !== undefined ? { summary } : {}),
    });
  }
  // `export const act = (...) => ...` is the shape the shared helpers use.
  for (const statement of file.getVariableStatements()) {
    if (!statement.isExported()) continue;
    for (const decl of statement.getDeclarations()) {
      const init = decl.getInitializer();
      if (init === undefined) continue;
      if (!init.isKind(SyntaxKind.ArrowFunction) && !init.isKind(SyntaxKind.FunctionExpression)) {
        continue;
      }
      const summary = jsDocSummary(statement);
      entries.push({
        id: `${stem}.${decl.getName()}`,
        file: path,
        exportName: decl.getName(),
        ...(summary !== undefined ? { summary } : {}),
      });
    }
  }
  return entries;
}

/**
 * Credential getters, by naming convention.
 *
 * Convention rather than type analysis because the return type is usually an
 * inferred object literal in a file the scanner cannot resolve. A false
 * positive here costs nothing — an extra name in a list — while a false
 * negative means the generator invents a getter.
 */
function readCredentials(file: SourceFile, path: string): CredentialEntry[] {
  const entries: CredentialEntry[] = [];
  for (const fn of exportedFunctions(file)) {
    const name = fn.getName();
    if (name === undefined || !/^get.*Credentials$/.test(name)) continue;
    const role = jsDocSummary(fn) ?? roleFromGetter(name);
    entries.push({ getter: name, file: path, ...(role !== undefined ? { role } : {}) });
  }
  return entries;
}

/** `getBAPBadgeSupportCredentials` -> `BAP Badge Support`. */
export function roleFromGetter(name: string): string | undefined {
  const core = name.replace(/^get_?/, '').replace(/Credentials$/, '');
  if (core === '') return undefined;
  return (
    core
      .replace(/_/g, ' ')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      // Acronym followed by a word: `BAPBadge` -> `BAP Badge`. Without this the
      // roles read as `BAPBadge Support`, and the role string is what a spec
      // author matches against when picking `role:` for a feature.
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .trim()
  );
}

function readRepositories(file: SourceFile, path: string): RepositoryEntry[] {
  const entries: RepositoryEntry[] = [];
  for (const cls of file.getClasses()) {
    const name = cls.getName();
    if (name === undefined || !/Repository$/.test(name)) continue;
    entries.push({
      className: name,
      file: path,
      methods: cls
        .getMethods()
        .filter((m) => !m.hasModifier(SyntaxKind.PrivateKeyword))
        .map((m) => m.getName())
        .sort((a, b) => a.localeCompare(b)),
    });
  }
  return entries;
}

/**
 * Fill in `usedBy` by finding which tests import each flow.
 *
 * Both import shapes matter. The four-layer test template uses dynamic
 * `await import('../flows/x.flow')` — because env vars must load before the
 * modules that read them — so a scanner that only understood static imports
 * would report every flow as unused and give the reuse check nothing to work
 * with.
 */
function attributeUsage(
  flows: FlowEntry[],
  files: SourceFile[],
  rel: (file: SourceFile) => string,
): void {
  const byName = new Map<string, FlowEntry[]>();
  for (const flow of flows) {
    const list = byName.get(flow.exportName) ?? [];
    list.push(flow);
    byName.set(flow.exportName, list);
  }

  for (const file of files) {
    const path = rel(file);
    if (!isTestFile(path)) continue;
    for (const name of importedNames(file)) {
      for (const flow of byName.get(name) ?? []) {
        if (!flow.usedBy.includes(path)) flow.usedBy.push(path);
      }
    }
  }
  for (const flow of flows) flow.usedBy.sort((a, b) => a.localeCompare(b));
}

function importedNames(file: SourceFile): string[] {
  const names: string[] = [];
  for (const decl of file.getImportDeclarations()) {
    for (const named of decl.getNamedImports()) names.push(named.getName());
  }
  // `const { createBadge } = await import('../flows/badge-creation.flow');`
  for (const statement of file.getVariableStatements()) {
    for (const decl of statement.getDeclarations()) {
      const binding = decl.getNameNode();
      if (!binding.isKind(SyntaxKind.ObjectBindingPattern)) continue;
      if (!mentionsImport(statement)) continue;
      for (const element of binding.getElements()) {
        names.push(element.getPropertyNameNode()?.getText() ?? element.getName());
      }
    }
  }
  return names;
}

function mentionsImport(statement: VariableStatement): boolean {
  return statement.getDescendantsOfKind(SyntaxKind.ImportKeyword).length > 0;
}

/** First line of the JSDoc block, which is where the intent is written. */
function jsDocSummary(node: Node): string | undefined {
  const docs = (node as unknown as { getJsDocs?: () => Array<{ getDescription: () => string }> })
    .getJsDocs?.()
    ?.map((d) => d.getDescription().trim())
    .filter((d) => d !== '');
  if (docs === undefined || docs.length === 0) return undefined;
  const first = docs[0]!
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')[0];
  return first === undefined || first === '' ? undefined : first;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
