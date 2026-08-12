import type { SelectorStrategy } from '../../shared/selector-ranking.js';

/**
 * The output-dialect seam (master plan B5 / D3).
 *
 * A dialect turns the emitter's dialect-agnostic description of a suite into
 * text. Everything upstream — which page objects exist, which selector won,
 * which cases become `test.fixme()` — is decided by the emitter and is the same
 * whatever the dialect. That split is what makes adding the `bubblegum` dialect
 * in Phase 6 a config change rather than a second emitter.
 *
 * A dialect must be a pure function of its input. No clock, no filesystem, no
 * randomness: regenerating a feature has to be byte-identical.
 */

/** A selector the extractor verified, chosen for one element. */
export interface EmittedSelector {
  strategy: SelectorStrategy;
  /** The stored candidate value, in the ranker's encoding. */
  value: string;
  score: number;
  /** Element id it came from, for traceability back to the Screen Model. */
  elementId: string;
  /** `button "Login"` — used in the comment above the locator. */
  description: string;
  /** Frame chain, when the element lives inside a same-origin iframe. */
  framePath?: string[];
}

/** One locator property on a page object. */
export interface EmittedLocator {
  /** Property name, e.g. `loginButton`. */
  name: string;
  selector: EmittedSelector;
}

/** One statement inside a generated page-object method. */
export interface EmittedAction {
  kind: 'click' | 'fill' | 'select';
  /** Locator property name this acts on. */
  locator: string;
  /** Present for fill/select; the method takes it as a parameter. */
  parameter?: string;
}

/** A method on a page object, derived from the plan steps that use it. */
export interface EmittedMethod {
  name: string;
  /** Parameter names, in order. All are `string`. */
  parameters: string[];
  actions: EmittedAction[];
  /** One-line doc comment. */
  summary: string;
}

/** Everything a dialect needs to write one page-object file. */
export interface PageObjectSpec {
  className: string;
  /** Screen Model page id — traceability, and the key for reuse checks. */
  pageId: string;
  /** Absolute URL captured during exploration. */
  url: string;
  /** Normalized pattern, used for the `goto` helper and the header comment. */
  urlPattern: string;
  locators: EmittedLocator[];
  methods: EmittedMethod[];
}

/** An assertion in a spec, already resolved to a locator or a page-level fact. */
export interface EmittedAssertion {
  kind: 'visible' | 'hidden' | 'text' | 'url' | 'count' | 'value' | 'toast';
  expected: string | number | boolean;
  /** `<pageObjectVariable>.<locatorName>`, absent for page-level kinds. */
  target?: { pageVariable: string; locator: string };
}

/** One statement in a generated test body. */
export type EmittedStatement =
  /** With a pageVariable this calls the page object's own `goto()`. */
  | { kind: 'goto'; pageVariable?: string; url: string }
  | { kind: 'call'; pageVariable: string; method: string; args: string[] }
  | { kind: 'assert'; assertion: EmittedAssertion }
  | { kind: 'comment'; text: string };

/** How a case is emitted — the LOCKED precedence from the TestPlan schema. */
export type EmittedTestMode =
  { kind: 'live' } | { kind: 'fixme'; reason: string } | { kind: 'skip'; reason: string };

/** One `test(...)` in a spec file. */
export interface EmittedTest {
  /** Plan case id — kept as a comment so a run report maps back to the plan. */
  caseId: string;
  title: string;
  tags: string[];
  mode: EmittedTestMode;
  /** Page objects this test constructs, in construction order. */
  pageObjects: Array<{ variable: string; className: string; importPath: string }>;
  statements: EmittedStatement[];
  /** Rendered above the test as context for a human reviewer. */
  notes: string[];
}

/** Everything a dialect needs to write one spec file. */
export interface SpecFileSpec {
  featureId: string;
  /** `describe` title — the feature spec's human title. */
  title: string;
  tests: EmittedTest[];
}

/**
 * A code-emission style guide. Implementations live in this directory and are
 * selected by `config.dialect`.
 */
export interface Dialect {
  /** Config value that selects this dialect. */
  readonly name: string;
  /** Directory under the suite root for page objects, e.g. `pages`. */
  readonly pageObjectDir: string;
  /** Directory under the suite root for specs, e.g. `tests`. */
  readonly specDir: string;
  /** Render one page-object file. Must be deterministic. */
  emitPageObject(spec: PageObjectSpec): string;
  /** Render one spec file. Must be deterministic. */
  emitSpec(spec: SpecFileSpec): string;
}
