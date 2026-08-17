import type { FeatureSpec } from './feature-spec.js';
import type { AppKnowledge, EntityDoc, StateSetup } from '../schemas/kb-app.js';
import type { SuiteManifest } from '../schemas/manifest.js';

/**
 * What a feature needs that the knowledge base cannot yet supply.
 *
 * The premise of B2, and the reason this is a report rather than a form: asking
 * a BA to document an application in the abstract produces a document nobody
 * finishes. Asking them three specific questions, raised at the moment somebody
 * actually needs the answers, produces answers. The knowledge base then grows
 * from use rather than from discipline, which is the only way these documents
 * survive contact with a delivery schedule.
 *
 * Every check here is deterministic — string matching against the manifest and
 * the KB, no model call. That matters because this runs before planning, on
 * every feature, and a gap report that cost a model call per feature would be
 * switched off within a week.
 */

export type GapKind =
  /** A `dataNeeds` entry naming an entity nothing describes. */
  | 'unknown-entity'
  /** The entity is described, but not this state. */
  | 'unknown-state'
  /** The state is described as impossible to reach. */
  | 'unreachable-state'
  /** The KB names a repository method or flow that does not exist. */
  | 'dangling-reference'
  /** A `dataNeeds` entry too vague to resolve to anything. */
  | 'unresolved-need'
  /** The spec's `pages:` hint matches no page in the Screen Model. */
  | 'unknown-page';

export interface KbGap {
  kind: GapKind;
  /** Feature that surfaced it. */
  featureId: string;
  /** The thing that could not be grounded, quoted from the spec or KB. */
  what: string;
  /** Why it is a gap, in one line. */
  reason: string;
  /** What a human should do about it — a file and a fact, never "investigate". */
  fix: string;
  /** Near misses, when the failure looks like a typo rather than an omission. */
  candidates?: string[];
}

export interface GapCheckInput {
  spec: FeatureSpec;
  knowledge: AppKnowledge;
  manifest: SuiteManifest;
  /** `urlPattern`s in the Screen Model, for checking `pages:` hints. */
  knownPages?: string[];
  kbDir?: string;
}

export interface GapReport {
  featureId: string;
  gaps: KbGap[];
  /** `dataNeeds` entries that did resolve, and how. */
  grounded: Array<{ need: string; entity: string; state: string; via: string }>;
}

export function checkKbGaps(input: GapCheckInput): GapReport {
  const { spec, knowledge, manifest } = input;
  const featureId = spec.frontmatter.id;
  const kbDir = input.kbDir ?? 'kb';
  const gaps: KbGap[] = [];
  const grounded: GapReport['grounded'] = [];

  for (const need of spec.frontmatter.dataNeeds ?? []) {
    const match = matchEntity(need, knowledge.entities);

    if (match === undefined) {
      gaps.push({
        kind: 'unknown-entity',
        featureId,
        what: need,
        reason: 'no entity in the knowledge base matches this.',
        fix: `Describe it in ${kbDir}/app/entities/<entity>.md, or add an alias to an existing file.`,
        ...(knowledge.entities.length > 0
          ? { candidates: knowledge.entities.map((e) => e.entity) }
          : {}),
      });
      continue;
    }

    const state = matchState(need, match);
    if (state === undefined) {
      const known = Object.keys(match.states);
      gaps.push({
        kind: known.length === 0 ? 'unresolved-need' : 'unknown-state',
        featureId,
        what: need,
        reason:
          known.length === 0
            ? `\`${match.entity}\` is described but lists no states.`
            : `\`${match.entity}\` has no state matching this need.`,
        fix: `Add it under \`states:\` in ${kbDir}/app/entities/${match.entity}.md.`,
        ...(known.length > 0 ? { candidates: known } : {}),
      });
      continue;
    }

    const setup = match.states[state]!;

    if (setup.unreachable !== undefined) {
      // Not a documentation gap — a documented dead end, which is exactly what
      // the field is for. Still reported, because a plan built on it will not
      // run, and the operator should hear that before paying to generate it.
      gaps.push({
        kind: 'unreachable-state',
        featureId,
        what: need,
        reason: `\`${match.entity}\` state \`${state}\` is recorded as unreachable: ${setup.unreachable}`,
        fix: 'Drop this case from the spec, or add a setup path once one exists.',
      });
      continue;
    }

    const dangling = danglingReference(setup, manifest);
    if (dangling !== undefined) {
      gaps.push({
        kind: 'dangling-reference',
        featureId,
        what: `${match.entity}.${state} -> ${dangling.reference}`,
        reason: `${dangling.what} does not exist in the suite.`,
        fix: `Fix the reference in ${kbDir}/app/entities/${match.entity}.md, or run \`flint manifest\` if the suite changed.`,
        ...(dangling.candidates.length > 0 ? { candidates: dangling.candidates } : {}),
      });
      continue;
    }

    grounded.push({ need, entity: match.entity, state, via: describeSetup(setup) });
  }

  for (const page of spec.frontmatter.pages ?? []) {
    if (input.knownPages === undefined) break;
    if (input.knownPages.some((p) => p === page || p.includes(page))) continue;
    gaps.push({
      kind: 'unknown-page',
      featureId,
      what: page,
      reason: 'no page in the Screen Model matches this hint.',
      fix: 'Re-run `flint explore`, or correct the `pages:` hint in the feature spec.',
      candidates: input.knownPages.slice(0, 8),
    });
  }

  return { featureId, gaps, grounded };
}

/**
 * Which entity a free-text need refers to.
 *
 * Word matching against the entity id and its aliases, deliberately simple. A
 * tester writes "user with GAQ status unfit", not `gaq:unfit`, and a schema
 * that demanded the second would be ignored. Matching on whole words rather
 * than substrings keeps `gaq` from matching inside another word, and the
 * longest match wins so a specific entity beats a general one.
 */
export function matchEntity(need: string, entities: EntityDoc[]): EntityDoc | undefined {
  let best: { entity: EntityDoc; length: number } | undefined;
  for (const entity of entities) {
    for (const name of [entity.entity, ...entity.aliases]) {
      if (!containsPhrase(need, name)) continue;
      if (best === undefined || name.length > best.length) {
        best = { entity, length: name.length };
      }
    }
  }
  return best?.entity;
}

/** Which of the entity's states the need is asking for. Longest match wins. */
export function matchState(need: string, entity: EntityDoc): string | undefined {
  let best: string | undefined;
  for (const state of Object.keys(entity.states)) {
    if (!containsPhrase(need, state)) continue;
    if (best === undefined || state.length > best.length) best = state;
  }
  return best;
}

/**
 * Whether `haystack` contains `phrase` as whole words.
 *
 * Hyphens and spaces are treated alike, so `partial-fit` in a KB file matches
 * "partial fit" in a spec. Without that the two notations never meet and the
 * report blames the author for a punctuation choice.
 */
function containsPhrase(haystack: string, phrase: string): boolean {
  const normalise = (s: string): string =>
    ` ${s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()} `;
  return normalise(haystack).includes(normalise(phrase));
}

/** A KB reference pointing at something the suite does not have. */
function danglingReference(
  setup: StateSetup,
  manifest: SuiteManifest,
): { reference: string; what: string; candidates: string[] } | undefined {
  if (setup.repository !== undefined) {
    const [className, method] = splitRef(setup.repository);
    const repo = manifest.repositories.find((r) => r.className === className);
    if (repo === undefined) {
      return {
        reference: setup.repository,
        what: `repository \`${className}\``,
        candidates: near(
          className,
          manifest.repositories.map((r) => r.className),
        ),
      };
    }
    if (method !== undefined && !repo.methods.includes(method)) {
      return {
        reference: setup.repository,
        what: `\`${className}.${method}\``,
        candidates: near(method, repo.methods),
      };
    }
  }

  if (setup.flow !== undefined) {
    const known = manifest.flows.map((f) => f.id);
    if (!known.includes(setup.flow)) {
      return {
        reference: setup.flow,
        what: `flow \`${setup.flow}\``,
        candidates: near(setup.flow, known),
      };
    }
  }
  return undefined;
}

function splitRef(reference: string): [string, string | undefined] {
  const dot = reference.indexOf('.');
  return dot === -1 ? [reference, undefined] : [reference.slice(0, dot), reference.slice(dot + 1)];
}

/**
 * Plausible alternatives for a name that did not resolve.
 *
 * Substring matching alone is not enough, because the mistake people actually
 * make is the right noun with the wrong verb: someone writes
 * `UserRepository.setGAQStatus` when the method is `updateGAQ`. Those share no
 * substring, so a substring check offers no suggestion at exactly the moment
 * one would help most.
 *
 * So names are compared by their meaningful words, with the verbs and type
 * suffixes every name shares thrown away first — otherwise every repository
 * would suggest every other repository on the strength of the word
 * "Repository", which is a suggestion with no information in it.
 */
export function near(wanted: string, available: string[]): string[] {
  const want = meaningfulTokens(wanted);
  const scored: Array<{ name: string; score: number }> = [];

  for (const name of available) {
    const other = name.toLowerCase();
    const needle = wanted.toLowerCase();
    // Containment stays as a strong signal: a missing prefix or a plural.
    let score = other.includes(needle) || needle.includes(other) ? 100 : 0;
    for (const token of meaningfulTokens(name)) {
      if (want.has(token)) score += 10;
      else if ([...want].some((w) => w.includes(token) || token.includes(w))) score += 4;
    }
    if (score > 0) scored.push({ name, score });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 5)
    .map((s) => s.name);
}

/**
 * Words shared by half the codebase carry no signal about which name was meant.
 */
const GENERIC_TOKENS = new Set([
  'get',
  'set',
  'update',
  'delete',
  'create',
  'insert',
  'remove',
  'add',
  'repository',
  'credentials',
  'flow',
  'by',
  'for',
  'the',
  'and',
]);

function meaningfulTokens(name: string): Set<string> {
  const parts = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 1 && !GENERIC_TOKENS.has(t));
  return new Set(parts);
}

function describeSetup(setup: StateSetup): string {
  if (setup.repository !== undefined) return setup.repository;
  if (setup.flow !== undefined) return `flow ${setup.flow}`;
  if (setup.api !== undefined) return `api ${setup.api}`;
  return 'unspecified';
}

/**
 * Every reference in the knowledge base, checked against the suite.
 *
 * Independent of any feature, and that is the point. A state nobody needs
 * today still names a repository method, and if somebody renamed that method
 * last week the KB is already wrong — you simply have not run the feature that
 * would notice. Checking only what the current spec touches means finding these
 * one at a time, months apart, each time blaming the spec that happened to be
 * unlucky.
 *
 * This is the same referential rule the planner applies to element ids, turned
 * on the knowledge base itself.
 */
export function checkKnowledgeIntegrity(
  knowledge: AppKnowledge,
  manifest: SuiteManifest,
  kbDir = 'kb',
): KbGap[] {
  const gaps: KbGap[] = [];

  for (const entity of knowledge.entities) {
    for (const [state, setup] of Object.entries(entity.states)) {
      const dangling = danglingReference(setup, manifest);
      if (dangling === undefined) continue;
      gaps.push({
        kind: 'dangling-reference',
        featureId: `${kbDir}/app/entities/${entity.entity}.md`,
        what: `${entity.entity}.${state} -> ${dangling.reference}`,
        reason: `${dangling.what} does not exist in the suite.`,
        fix: `Fix the reference, or run \`flint manifest\` if the suite changed.`,
        ...(dangling.candidates.length > 0 ? { candidates: dangling.candidates } : {}),
      });
    }
  }

  for (const role of knowledge.roles) {
    if (role.credentials === undefined) continue;
    const known = manifest.credentials.map((c) => c.getter);
    if (known.includes(role.credentials)) continue;
    gaps.push({
      kind: 'dangling-reference',
      featureId: `${kbDir}/app/roles.md`,
      what: `${role.id} -> ${role.credentials}`,
      reason: 'no such credential getter in the suite.',
      fix: 'Correct the getter name, or add it to the credentials package.',
      ...(near(role.credentials, known).length > 0
        ? { candidates: near(role.credentials, known) }
        : {}),
    });
  }

  return gaps.sort(
    (a, b) => a.featureId.localeCompare(b.featureId) || a.what.localeCompare(b.what),
  );
}

/** Gaps that should stop a run rather than merely inform it. */
export function isBlocking(gap: KbGap): boolean {
  return gap.kind === 'dangling-reference' || gap.kind === 'unreachable-state';
}
