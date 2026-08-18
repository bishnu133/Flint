import { existsSync } from 'node:fs';
import { relative, resolve, basename } from 'node:path';
import {
  Project,
  SyntaxKind,
  type SourceFile,
  type ClassDeclaration,
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

  // A path that does not exist reads as an empty scan, and an empty scan is a
  // legitimate answer for a new project — so without this check a mistyped
  // `suiteDir` and a greenfield suite are indistinguishable, both reporting
  // zero of everything. Naming the resolved absolute path matters more than
  // the warning itself: `packages/web-tests/src/smart-tests` looks right until
  // you see what it resolved against.
  missingRootWarning(suiteRoot, 'suiteDir', warnings);
  for (const root of options.extraRoots ?? []) {
    missingRootWarning(resolve(options.projectRoot, root), '--root', warnings);
  }

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
    // Remembered so the next command does not have to be told again. Sorted
    // with everything else, because the manifest is diffed.
    roots: [...(options.extraRoots ?? [])].sort(),
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
  // Debug, not info, and the reason is worth stating. This line duplicates the
  // summary the command already prints to stdout, so at info level its only
  // effect is to put a JSON blob on stderr that tempts people into
  // `2>/dev/null` — which then silently discards the errors that share that
  // stream. A scan that found nothing because the config was missing then looks
  // exactly like a scan that found nothing because the suite is empty. Quiet
  // stderr on success is what keeps stderr worth reading on failure.
  logger.debug(
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

function missingRootWarning(
  absolute: string,
  which: string,
  warnings: Array<{ file: string; message: string }>,
): void {
  if (existsSync(absolute)) return;
  warnings.push({
    file: absolute,
    message: `${which} does not exist — nothing was scanned from here. Check the path is relative to the project root.`,
  });
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
  // Before `create`, so `submitForApproval` is a transition rather than a
  // creation — it matches both, and the more specific reading is the true one.
  if (
    /^(approve|reject|publish|unpublish|activate|deactivate|archive|cancel|submitFor)/i.test(name)
  ) {
    return 'transition';
  }
  if (/^(create|add|submit|register)/i.test(name)) return 'create';
  if (/^(validate|verify|assert|check|expect)/i.test(name)) return 'validate';
  if (/^(cleanup|teardown|delete|remove|purge)/i.test(name)) return 'cleanup';
  return 'other';
}

function readFlows(file: SourceFile, path: string): FlowEntry[] {
  const domain = domainOf(path);
  return exportedCallables(file).map((fn) => {
    const summary = jsDocSummary(fn.docNode);
    return {
      id: `${domain}.${fn.name}`,
      file: path,
      exportName: fn.name,
      domain,
      kind: flowKindOf(fn.name),
      ...(summary !== undefined ? { summary } : {}),
      params: fn.params,
      returns: fn.returns,
      phrases: phrasesIn(fn.body),
      usedBy: [],
    };
  });
}

/** A named, exported thing that holds a body — however it was declared. */
interface Callable {
  name: string;
  params: Array<{ name: string; type: string }>;
  returns: string;
  /** Node to search for `act`/`verify` calls. */
  body: Node;
  /** Node the JSDoc hangs off — the statement, for `export const`. */
  docNode: Node;
}

/**
 * Every exported callable in a file, in both shapes TypeScript allows.
 *
 * `export async function loginFlow()` and `export const loginFlow = async () =>`
 * are the same thing to everyone except an AST, which files them under
 * `FunctionDeclaration` and `PropertyDeclaration`/`VariableDeclaration`
 * respectively. Reading only the first shape was a real gap: a suite written in
 * the arrow style would report zero flows and the manifest would tell the
 * generator, with total confidence, that there is nothing to reuse.
 */
function exportedCallables(file: SourceFile): Callable[] {
  const out: Callable[] = [];

  for (const fn of file.getFunctions()) {
    const name = fn.getName();
    if (!fn.isExported() || name === undefined || name === '') continue;
    out.push({
      name,
      params: paramsOf(fn),
      returns: fn.getReturnTypeNode()?.getText() ?? '',
      body: fn,
      docNode: fn,
    });
  }

  for (const statement of file.getVariableStatements()) {
    if (!statement.isExported()) continue;
    for (const decl of statement.getDeclarations()) {
      const init = decl.getInitializer();
      if (init === undefined) continue;
      if (!init.isKind(SyntaxKind.ArrowFunction) && !init.isKind(SyntaxKind.FunctionExpression)) {
        continue;
      }
      out.push({
        name: decl.getName(),
        params: paramsOf(init),
        returns: init.getReturnTypeNode()?.getText() ?? '',
        body: init,
        // JSDoc sits above `export const`, which is the statement, not the
        // declaration inside it.
        docNode: statement,
      });
    }
  }
  return out;
}

function paramsOf(node: {
  getParameters: () => Array<{
    getName: () => string;
    getTypeNode: () => { getText: () => string } | undefined;
  }>;
}): Array<{ name: string; type: string }> {
  return node.getParameters().map((p) => ({
    name: p.getName(),
    type: p.getTypeNode()?.getText() ?? '',
  }));
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
  return exportedCallables(file).map((fn) => {
    const summary = jsDocSummary(fn.docNode);
    return {
      id: `${stem}.${fn.name}`,
      file: path,
      exportName: fn.name,
      ...(summary !== undefined ? { summary } : {}),
    };
  });
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
  for (const fn of exportedCallables(file)) {
    if (!looksLikeCredentialGetter(fn, file)) continue;
    const role = jsDocSummary(fn.docNode) ?? roleFromGetter(fn.name);
    entries.push({ getter: fn.name, file: path, ...(role !== undefined ? { role } : {}) });
  }
  return entries;
}

/**
 * Is this function a credential getter?
 *
 * Two signals, because one was not enough. The name convention
 * (`get…Credentials`) catches most of them, but a real project had
 * `getCustomerSupportLevel1()` sitting in the same file doing the same job — and
 * missing it means the generator either invents a getter or a `roles.md` entry
 * naming the real one gets reported as a broken reference. A false negative
 * here is expensive; a false positive is one extra name in a list.
 *
 * So the second signal is what the function returns: an object literal with
 * both `username` and `password`. That is checkable from syntax alone, which
 * matters because these files import from workspace packages the scanner
 * deliberately does not resolve.
 *
 * The third is the declared return type. A suite whose login flow is typed
 * `(engine, page, credentials: LoginCredentials)` has already named the concept;
 * every function that produces one is a credential getter whatever it is called,
 * and the annotation is right there in the syntax. This signal deliberately does
 * not require the `get` prefix — the point of it is to survive a project that
 * names things its own way.
 */
function looksLikeCredentialGetter(fn: Callable, file: SourceFile): boolean {
  if (/^get.*Credentials$/.test(fn.name)) return true;
  if (/credential/i.test(fn.returns)) return true;
  if (!/^get[A-Z_]/.test(fn.name)) return false;
  if (hasCredentialLiteral(fn.body)) return true;

  // The realistic shape: `const byEnv = { CCSIT: { username, password } };`
  // at module level, and the getter returns `byEnv[env]`. The literal is not
  // inside the function at all, so following the returned name is the only way
  // to see it — and this is how the environment-keyed credential files in a
  // real monorepo are actually written.
  for (const name of returnedRootNames(fn.body)) {
    const decl = file.getVariableDeclaration(name);
    if (decl !== undefined && hasCredentialLiteral(decl)) return true;
  }
  return false;
}

function hasCredentialLiteral(node: Node): boolean {
  for (const literal of node.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)) {
    const keys = new Set(
      literal
        .getProperties()
        .map(propertyName)
        .filter((n): n is string => n !== undefined),
    );
    if (keys.has('username') && keys.has('password')) return true;
  }
  return false;
}

/** Base identifier of each returned expression: `byEnv[x].y` -> `byEnv`. */
function returnedRootNames(body: Node): string[] {
  const names: string[] = [];
  for (const statement of body.getDescendantsOfKind(SyntaxKind.ReturnStatement)) {
    let expression = statement.getExpression();
    while (expression !== undefined) {
      if (expression.isKind(SyntaxKind.Identifier)) {
        names.push(expression.getText());
        break;
      }
      if (
        expression.isKind(SyntaxKind.PropertyAccessExpression) ||
        expression.isKind(SyntaxKind.ElementAccessExpression)
      ) {
        expression = expression.getExpression();
        continue;
      }
      break;
    }
  }
  return names;
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
      methods: repositoryOperations(cls),
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

/**
 * A repository's usable operations.
 *
 * Both declaration shapes, for the same reason flows need both: this codebase
 * writes some repositories as `async deleteX() {}` and others as
 * `deleteX = async () => {}`, and reading only the first made twenty of
 * twenty-four repositories look like they exposed nothing but `getInstance`.
 * That very nearly became a conclusion about whether the framework could seed
 * test data at all.
 *
 * `getInstance` is kept rather than filtered — it is noise for the generator
 * but its absence would be a lie about what the class exposes, and a reader
 * comparing this against the source should find them identical.
 */
function repositoryOperations(cls: ClassDeclaration): string[] {
  const names = cls
    .getMethods()
    .filter((m) => !m.hasModifier(SyntaxKind.PrivateKeyword))
    .map((m) => m.getName());

  for (const prop of cls.getProperties()) {
    if (prop.hasModifier(SyntaxKind.PrivateKeyword)) continue;
    const init = prop.getInitializer();
    if (init === undefined) continue;
    if (init.isKind(SyntaxKind.ArrowFunction) || init.isKind(SyntaxKind.FunctionExpression)) {
      names.push(prop.getName());
    }
  }
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
