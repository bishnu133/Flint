import { DraftedKbSchema, type DraftedKb, type DraftState } from '../schemas/draft.js';
import type { AppKnowledge } from '../schemas/kb-app.js';
import type { SuiteManifest } from '../schemas/manifest.js';
import type { ScreenModel } from '../schemas/screen-model.js';
import type { LLMProvider } from '../llm/types.js';
import { loadAndRender } from '../generator/template-loader.js';
import { silentLogger, type Logger } from '../shared/logger.js';
import { near } from './kb-gaps.js';
import { checkDraftNeeds, type NeedCheck } from './draft-check.js';

/**
 * Draft a knowledge base from a requirement document (Bubblegum B2.5).
 *
 * The stage that was missing. B2 built the machinery to *check* a knowledge
 * base and left a human to write it — which meant hand-copying facts that were
 * already sitting in the card and the manifest. Nearly everything in a first
 * draft is a mechanical join of the two: the states come from the requirement
 * text, and the setup paths come from method names Flint already scanned.
 *
 * One model call. Everything it returns is then resolved deterministically:
 * the model says what needs to happen, and Flint decides what it is called.
 */

export interface DraftOptions {
  /** The requirement document, verbatim. */
  document: string;
  /** Shown to the model so it knows what the suite can already do. */
  manifest: SuiteManifest;
  provider: LLMProvider;
  /** `config.models.planner`. */
  modelId: string;
  model?: ScreenModel;
  /** So the draft extends the KB rather than proposing it again. */
  existing?: AppKnowledge;
  tokenBudget?: number;
  logger?: Logger;
}

export interface DraftResult {
  draft: DraftedKb;
  /** Per-state outcome of matching `setupHint` against the suite. */
  resolutions: Resolution[];
  /**
   * Whether the draft grounds its own preconditions, checked with the matchers
   * `flint kb` uses. A draft that will score zero should say so here, not two
   * commands later.
   */
  needs: NeedCheck[];
  estimatedPromptTokens: number;
}

export interface Resolution {
  entity: string;
  state: string;
  hint: string;
  /** What the hint resolved to, if anything. */
  reference?: string;
  kind: 'repository' | 'flow' | 'unresolved';
  /** Alternatives, when the hint was close to something but not exact. */
  candidates: string[];
}

export async function draftKnowledgeBase(options: DraftOptions): Promise<DraftResult> {
  const logger = options.logger ?? silentLogger();

  const rendered = loadAndRender('draft-kb', {
    document: options.document.trim(),
    suite: describeSuite(options.manifest),
    screens: describeScreens(options.model),
    existing: describeExisting(options.existing),
  });

  const result = await options.provider.structured(DraftedKbSchema, {
    model: options.modelId,
    prompt: rendered.text,
    temperature: 0,
    meta: { stage: 'draft', purpose: 'requirement document -> draft knowledge base' },
  });

  // Re-parsed so the defaults in the schema are materialised. `structured`
  // hands back the inferred *input* shape, where every defaulted field is still
  // optional; downstream code should not have to ask whether `outOfScope` is an
  // empty array or absent when the schema already says it is an array.
  const draft: DraftedKb = DraftedKbSchema.parse(result.data);
  const resolutions = draft.entities.flatMap((entity) =>
    entity.states
      .filter((state) => state.setupHint !== undefined)
      .map((state) => resolveSetup(entity.entity, state, options.manifest)),
  );

  const needs = checkDraftNeeds(draft, options.existing);

  logger.info(
    {
      features: draft.features.length,
      entities: draft.entities.length,
      outOfScope: draft.outOfScope.length,
      unresolved: resolutions.filter((r) => r.kind === 'unresolved').length,
      ungrounded: needs.filter((n) => n.status !== 'grounded').length,
    },
    'draft: generated',
  );

  return {
    draft,
    resolutions,
    needs,
    estimatedPromptTokens: Math.ceil(rendered.text.length / 4),
  };
}

/**
 * Warn when a document looks like an export carrying more markup than content.
 *
 * A JIRA XML export of one card measured 49,705 input tokens; the same card as
 * plain text was under 3,000. The draft still works — the model reads past the
 * markup — but the operator pays for every token of it on every run, and the
 * signal-to-noise ratio is worse for no benefit. Worth one line rather than a
 * silent 16x.
 */
export function documentWarning(document: string, name: string): string | undefined {
  // ~4 chars per token, and 100k chars is roughly 25k tokens — far more than any
  // single requirement actually contains.
  if (document.length < 100_000) return undefined;
  const extension = /\.(\w+)$/.exec(name)?.[0];
  const noisy = extension !== undefined && ['.xml', '.html', '.htm'].includes(extension);
  return (
    `${name} is ${Math.round(document.length / 1000)}k characters` +
    (noisy ? ` — ${extension} exports carry a lot of markup.` : '.') +
    ' Exporting the card as text or markdown usually cuts this by an order of' +
    ' magnitude, for the same draft at a fraction of the cost.'
  );
}

/**
 * Turn a free-text setup hint into a reference the suite actually has.
 *
 * Exact match first, then near-match, then nothing. The third outcome is a
 * feature: an unresolved hint is written into the KB as a TODO comment beside
 * the words the model used, which is honest and easy to fix. Guessing the
 * closest method and writing it as fact would produce a knowledge base that
 * looks finished and is quietly wrong — the failure mode this whole project
 * keeps having to design against.
 */
export function resolveSetup(
  entity: string,
  state: DraftState,
  manifest: SuiteManifest,
): Resolution {
  const hint = state.setupHint ?? '';
  const base = { entity, state: state.name, hint };

  const methods = manifest.repositories.flatMap((repo) =>
    repo.methods.map((method) => `${repo.className}.${method}`),
  );
  const flows = manifest.flows.map((flow) => flow.id);

  const exactMethod = methods.find((m) => containsToken(hint, m));
  if (exactMethod !== undefined) {
    return { ...base, reference: exactMethod, kind: 'repository', candidates: [] };
  }

  const exactFlow = flows.find((f) => containsToken(hint, f));
  if (exactFlow !== undefined) {
    return { ...base, reference: exactFlow, kind: 'flow', candidates: [] };
  }

  // No exact name in the hint. Offer what is close, but do not pick — the hint
  // is prose, and prose that merely resembles a method name is not evidence.
  const candidates = hintCandidates(hint, methods, flows);
  return { ...base, kind: 'unresolved', candidates };
}

/**
 * Plausible methods for a setup hint — or nothing, when the hint is a paragraph.
 *
 * `near` compares *names*: the right noun with the wrong verb, which is the
 * mistake people make when they write `setGAQStatus` for `updateGAQ`. A hint of
 * a few words is close enough to a name for that comparison to mean something.
 *
 * A hint of twenty words is not a name, it is a situation — "Log in as a user
 * assigned the Vendor Admin role but not the HPB Activity Vendor User Manager
 * role". In a suite of 200 methods, some of them share "user" or "activity"
 * with any sentence you care to write, so a live run offered five repositories
 * about dashboard goals as the closest match for a login. That is noise printed
 * exactly where a reader is scanning for a lead, and it makes the honest
 * suggestions beside it less believable too. Saying nothing is the better
 * answer.
 *
 * A hint that does name a real method never reaches here — `containsToken`
 * matched it outright.
 */
export function hintCandidates(hint: string, methods: string[], flows: string[]): string[] {
  const words = hint.split(/[^A-Za-z0-9]+/).filter((word) => word.length > 1);
  if (words.length > MAX_HINT_WORDS) return [];
  return [...near(hint, methods), ...near(hint, flows)].slice(0, 5);
}

/** Where a hint stops reading as a name and starts reading as a sentence. */
const MAX_HINT_WORDS = 8;

/** Whether a hint names a reference outright, as a whole token. */
function containsToken(hint: string, reference: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_.])${escapeRegExp(reference)}([^A-Za-z0-9_]|$)`).test(hint);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The suite, as the model needs to see it.
 *
 * Method names and flow summaries only — no bodies, no phrases. The model is
 * choosing what a test must set up, not writing code, and a full listing would
 * cost tokens to make the decision harder.
 */
function describeSuite(manifest: SuiteManifest): string {
  const lines: string[] = [];

  if (manifest.flows.length > 0) {
    lines.push('## Flows the suite already has', '');
    for (const flow of manifest.flows) {
      lines.push(`- \`${flow.id}\` (${flow.kind}) — ${flow.summary ?? 'no description'}`);
    }
    lines.push('');
  }

  if (manifest.repositories.length > 0) {
    lines.push(
      '## Data-access methods',
      '',
      'These are the only ways a test can set up state directly.',
      '',
    );
    for (const repo of manifest.repositories) {
      const usable = repo.methods.filter((m) => m !== 'getInstance');
      if (usable.length === 0) continue;
      lines.push(`- \`${repo.className}\`: ${usable.map((m) => `\`${m}\``).join(', ')}`);
    }
    lines.push('');
  }

  if (manifest.credentials.length > 0) {
    lines.push('## Credential getters', '');
    for (const cred of manifest.credentials) {
      lines.push(`- \`${cred.getter}\`${cred.role !== undefined ? ` — ${cred.role}` : ''}`);
    }
    lines.push('');
  }

  return lines.length === 0
    ? 'The suite is empty — nothing has been built yet, so nothing can be reused.'
    : lines.join('\n');
}

function describeScreens(model: ScreenModel | undefined): string {
  if (model === undefined || model.pages.length === 0) {
    return [
      'The application has not been explored yet, so no screen list is available.',
      'Judge scope from the document and the suite listing instead, and say in',
      '`openQuestions` if you could not tell whether a screen belongs to this app.',
    ].join('\n');
  }
  const lines = [`Base URL: ${model.baseUrl}`, ''];
  for (const page of model.pages) {
    lines.push(`- \`${page.urlPattern}\` — ${page.title}`);
  }
  return lines.join('\n');
}

function describeExisting(knowledge: AppKnowledge | undefined): string {
  if (knowledge === undefined) return 'Nothing yet.';
  const lines: string[] = [];
  if (knowledge.entities.length > 0) {
    lines.push('Entities already described (do not propose these again unless');
    lines.push('the document adds a state they lack):');
    for (const entity of knowledge.entities) {
      const states = Object.keys(entity.states).join(', ') || 'no states';
      lines.push(`- \`${entity.entity}\` — states: ${states}`);
    }
  }
  if (knowledge.roles.length > 0) {
    lines.push('', 'Roles already described:');
    for (const role of knowledge.roles) lines.push(`- \`${role.id}\``);
  }
  return lines.length === 0 ? 'Nothing yet.' : lines.join('\n');
}
