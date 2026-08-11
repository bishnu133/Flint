import type { ScreenModel, Element, Page } from '../schemas/screen-model.js';
import type { SuiteIndex } from '../schemas/suite-index.js';
import { pickBest } from '../explorer/selector-ranker.js';
import type { FeatureSpec } from './feature-spec.js';
import { matchPages, type PageMatch } from './page-matcher.js';

/**
 * Context Builder — assembles what Stage A gets to see.
 *
 * Two jobs. First, present the Screen Model as something a planner can
 * reference: element ids with their role, name and *how to reach them*, because
 * an element behind a menu or a flow needs a precondition the plan must state.
 * Second, fit inside a hard token budget by dropping the least valuable thing
 * first — the master plan's priority order is spec > relevant pages > index >
 * exemplars, and it is followed literally here.
 *
 * Elements with no verified-unique selector are omitted entirely. Phase 4 could
 * not emit them anyway, so offering them to the planner only invites plans that
 * cannot be generated.
 */

export interface ExemplarFile {
  path: string;
  contents: string;
}

export interface BuildContextOptions {
  spec: FeatureSpec;
  model: ScreenModel;
  index?: SuiteIndex;
  /** House conventions (`kb/conventions.md`), verbatim. */
  conventions?: string;
  /** One or two existing spec files that show the house style. */
  exemplars?: ExemplarFile[];
  /** Hard ceiling, from `config.tokenBudgets.plan`. */
  tokenBudget: number;
  /** Cap on matched pages before budgeting. */
  maxPages?: number;
}

export interface BuiltContext {
  /** The assembled prompt context, ready to interpolate into the template. */
  text: string;
  /** Pages that survived budgeting, in prompt order. */
  pages: PageMatch[];
  /** Element ids the planner is allowed to reference. */
  allowedElementIds: Set<string>;
  /** Sections dropped to fit, most valuable last. */
  dropped: string[];
  estimatedTokens: number;
}

/**
 * Rough token estimate: ~4 characters per token.
 *
 * Deliberately not a real tokenizer. The budget exists to stop a runaway
 * prompt, and a cheap deterministic estimate keeps context assembly a pure
 * function — which is what makes it unit-testable without a model.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function buildContext(options: BuildContextOptions): BuiltContext {
  const { spec, model, tokenBudget } = options;
  const matches = matchPages(spec, model, { limit: options.maxPages ?? 8 });

  const specSection = renderSpec(spec);
  const dropped: string[] = [];

  // Priority order, least valuable first — that is the order things get cut.
  const optional: Array<{ name: string; render: () => string }> = [
    {
      name: 'exemplars',
      render: () => renderExemplars(options.exemplars ?? []),
    },
    {
      name: 'suite index',
      render: () => (options.index === undefined ? '' : renderIndex(options.index)),
    },
    {
      name: 'conventions',
      render: () => renderConventions(options.conventions),
    },
  ];

  // Start with everything, then drop optional sections, then trim pages.
  let includedPages = [...matches];
  const included = new Map(optional.map((s) => [s.name, s.render()]));

  const assemble = (): string =>
    [
      specSection,
      renderPages(includedPages),
      included.get('conventions') ?? '',
      included.get('suite index') ?? '',
      included.get('exemplars') ?? '',
    ]
      .filter((section) => section !== '')
      .join('\n\n');

  for (const section of optional) {
    if (estimateTokens(assemble()) <= tokenBudget) break;
    if ((included.get(section.name) ?? '') === '') continue;
    included.set(section.name, '');
    dropped.push(section.name);
  }

  // Still over budget: drop the least relevant pages, never the spec.
  while (estimateTokens(assemble()) > tokenBudget && includedPages.length > 1) {
    const cut = includedPages[includedPages.length - 1]!;
    includedPages = includedPages.slice(0, -1);
    dropped.push(`page ${cut.page.urlPattern}`);
  }

  const text = assemble();
  return {
    text,
    pages: includedPages,
    allowedElementIds: new Set(
      includedPages.flatMap((m) => usableElements(m.page).map((e) => e.id)),
    ),
    dropped,
    estimatedTokens: estimateTokens(text),
  };
}

/** Elements Phase 4 could actually emit — the rest are noise to the planner. */
export function usableElements(page: Page): Element[] {
  return page.elements.filter((element) => pickBest(element.selectorCandidates) !== undefined);
}

function renderSpec(spec: FeatureSpec): string {
  const fm = spec.frontmatter;
  const lines = [
    '## Feature specification',
    '',
    `- id: ${fm.id}`,
    `- title: ${fm.title}`,
    `- priority: ${fm.priority}`,
  ];
  if (fm.tags.length > 0) lines.push(`- tags: ${fm.tags.join(', ')}`);

  if (fm.acceptanceCriteria !== undefined && fm.acceptanceCriteria.length > 0) {
    lines.push('', '### Acceptance criteria', '');
    // Numbered so the plan can cite them in `acceptanceRefs` and the renderer
    // can produce a coverage checklist.
    fm.acceptanceCriteria.forEach((criterion, i) => lines.push(`- AC${i + 1}: ${criterion}`));
  }
  if (fm.negativeCases !== undefined && fm.negativeCases.length > 0) {
    lines.push('', '### Negative / edge cases required', '');
    for (const negative of fm.negativeCases) lines.push(`- ${negative}`);
  }
  if (fm.dataNeeds !== undefined && fm.dataNeeds.length > 0) {
    lines.push('', '### Declared data needs', '');
    for (const need of fm.dataNeeds) lines.push(`- ${need}`);
  }
  if (spec.body !== '') lines.push('', '### Description', '', spec.body);
  return lines.join('\n');
}

/**
 * Pages and their elements.
 *
 * `provenance` is rendered as an explicit precondition line, because an element
 * behind a menu or produced by a flow cannot be used without one — that is the
 * whole reason the field exists.
 */
function renderPages(matches: PageMatch[]): string {
  if (matches.length === 0) {
    return '## Screen Model\n\n(No pages matched this feature. Every case must be `blocked`.)';
  }
  const lines = ['## Screen Model — the ONLY elements you may reference', ''];

  // Say so when nothing actually matched. Otherwise a fallback list of every
  // page is indistinguishable from a curated one, and the planner will map the
  // spec onto whatever happens to be here rather than reporting the gap.
  if (matches.every((m) => m.reason === 'only-page')) {
    lines.push(
      '> **No page matched this feature.** The pages below are the whole model,',
      '> offered as a last resort. If the UI this spec describes is not among',
      '> them, emit `blocked` cases rather than substituting something similar.',
      '',
    );
  }
  for (const { page, reason } of matches) {
    lines.push(`### ${page.urlPattern}  (${page.title || 'untitled'})`);
    lines.push(`url: ${page.url}  ·  matched by: ${reason}`);
    if (page.lang !== undefined) lines.push(`lang: ${page.lang}`);
    lines.push('');

    const elements = usableElements(page);
    if (elements.length === 0) {
      lines.push('(no elements with a verified unique selector)', '');
      continue;
    }
    for (const element of elements) {
      lines.push(`- ${element.id} — ${element.role} "${element.name}"${describeState(element)}`);
      const precondition = describePrecondition(element);
      if (precondition !== undefined) lines.push(`    precondition: ${precondition}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function describeState(element: Element): string {
  const bits: string[] = [];
  if (element.testId !== undefined) bits.push(`testid=${element.testId}`);
  if (!element.states.enabled) bits.push('disabled');
  if (!element.states.visible) bits.push('not visible');
  return bits.length > 0 ? ` [${bits.join(', ')}]` : '';
}

function describePrecondition(element: Element): string | undefined {
  const provenance = element.provenance;
  if (provenance === undefined || provenance.kind === 'page') return undefined;
  if (provenance.kind === 'revealed') {
    return `only exists after clicking element ${provenance.openerElementId}`;
  }
  return `only exists in the state produced by flow "${provenance.flowId}" (step ${provenance.step})`;
}

function renderConventions(conventions: string | undefined): string {
  if (conventions === undefined || conventions.trim() === '') return '';
  return `## House conventions\n\n${conventions.trim()}`;
}

/**
 * Suite Index summary — what already exists, so the planner can mark duplicates.
 *
 * Summarised, not dumped: the planner needs test titles and their feature tags
 * to spot overlap, not the selector inventory of every page object.
 */
function renderIndex(index: SuiteIndex): string {
  const lines = ['## Existing test suite', ''];
  if (index.specs.length === 0 && index.pageObjects.length === 0) {
    return `${lines.join('\n')}(empty suite — nothing is covered yet)`;
  }

  if (index.pageObjects.length > 0) {
    lines.push('Page objects available for reuse:');
    for (const po of index.pageObjects) {
      const methods = po.methods.map((m) => m.name).join(', ');
      lines.push(`- ${po.className} (${po.file})${methods === '' ? '' : ` — ${methods}`}`);
    }
    lines.push('');
  }

  if (index.specs.length > 0) {
    lines.push('Existing tests (title — file):');
    for (const spec of index.specs) {
      for (const title of spec.testTitles) lines.push(`- "${title}" — ${spec.file}`);
    }
    lines.push('');
  }

  const covered = Object.entries(index.coverageMap);
  if (covered.length > 0) {
    lines.push('Coverage by feature id:');
    for (const [featureId, tests] of covered) {
      lines.push(`- ${featureId}: ${tests.length} test(s)`);
    }
  }
  return lines.join('\n').trimEnd();
}

function renderExemplars(exemplars: ExemplarFile[]): string {
  if (exemplars.length === 0) return '';
  const lines = ['## Example tests from this suite (house style)', ''];
  for (const exemplar of exemplars) {
    lines.push(`### ${exemplar.path}`, '', '```ts', exemplar.contents.trim(), '```', '');
  }
  return lines.join('\n').trimEnd();
}
