import type { FlowEntry, SuiteManifest } from '../../schemas/manifest.js';
import type { Phrase } from './phrase.js';

/**
 * Which flow the suite already has for what this test is about to do (B3).
 *
 * ## Why this is matching rather than asking a model
 *
 * "Never invent a flow" is this dialect's version of "never invent a selector",
 * and it needs the same kind of evidence. Ask a model to reuse the login and it
 * will write `loginToPortal()` when the export is `loginFlow` — the file
 * compiles, imports something that does not exist, and fails at run time.
 *
 * The evidence is already scanned. B1 records each flow's `act`/`verify`
 * phrases verbatim, template holes included:
 *
 *     login.loginFlow
 *       Enter "${credentials.username}" into Username
 *       Enter "${credentials.password}" into Password
 *       Click Sign In
 *
 * A plan that opens by filling a username, filling a password and clicking Sign
 * In produces those same three sentences with the holes filled. Comparing the
 * two is a string operation over facts, so the reuse is provable rather than
 * plausible — and when nothing matches, nothing is reused, which is the safe
 * direction.
 *
 * ## Why the prefix specifically
 *
 * A flow is a journey with a beginning. Matching anywhere in the step list would
 * let a login be spliced out of the middle of a test that was doing something
 * else, leaving the surrounding steps depending on state the call no longer
 * produces in that order. The prefix is where a precondition lives.
 */

export interface FlowMatch {
  flow: FlowEntry;
  /** How many leading phrases this flow accounts for. */
  consumed: number;
}

/**
 * The longest flow whose recorded phrases open this sequence, if any.
 *
 * Longest wins because a suite can hold both `loginFlow` and a
 * `loginAndOpenDashboard` that starts the same way; reusing the shorter one
 * would leave the test repeating steps the longer flow already performs.
 */
export function matchFlowPrefix(phrases: Phrase[], manifest: SuiteManifest): FlowMatch | undefined {
  const spoken = phrases.map(spokenText);
  let best: FlowMatch | undefined;

  for (const flow of manifest.flows) {
    if (flow.phrases.length === 0) continue;
    if (flow.phrases.length > spoken.length) continue;

    const matches = flow.phrases.every((recorded, index) =>
      phraseMatches(recorded, spoken[index]),
    );
    if (!matches) continue;
    if (best === undefined || flow.phrases.length > best.consumed) {
      best = { flow, consumed: flow.phrases.length };
    }
  }
  return best;
}

/**
 * Does a recorded phrase describe this generated one?
 *
 * `${...}` is a hole the flow fills from its own parameters, so it matches any
 * value — that is the whole reason the scanner keeps the holes rather than
 * resolving them. Everything outside a hole must match exactly: a flow that
 * clicks `Sign In` does not stand in for a step that clicks `Sign Up`.
 */
export function phraseMatches(recorded: string, generated: string | undefined): boolean {
  if (generated === undefined) return false;
  const pattern = recorded
    .split(/\$\{[^}]*\}/)
    .map(escapeRegExp)
    .join('[\\s\\S]*');
  return new RegExp(`^${pattern}$`).test(generated);
}

/** The sentence a phrase puts on the page, or nothing for non-spoken steps. */
function spokenText(phrase: Phrase): string | undefined {
  return phrase.kind === 'act' || phrase.kind === 'verify' ? phrase.text : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The auth flow and credential getter this feature should log in with.
 *
 * Derived from facts, not from reading the steps: the feature's `dataNeeds`
 * grounded to a role, the role names a credential getter, and the manifest says
 * which flow is `kind: 'auth'`. Every part of that chain was checked by
 * `flint kb` before generation, so the emitted call cannot name something that
 * is not there.
 *
 * Returns nothing when the suite has no auth flow, when it has several (which
 * is a choice, and a choice belongs to a human), or when no role grounded.
 */
export function resolveAuth(
  manifest: SuiteManifest,
  credentialGetters: string[],
): { flow: FlowEntry; getter: string } | undefined {
  const authFlows = manifest.flows.filter((flow) => flow.kind === 'auth' && isLogin(flow));
  if (authFlows.length !== 1) return undefined;

  const known = new Set(manifest.credentials.map((c) => c.getter));
  const getter = credentialGetters.find((name) => known.has(name));
  if (getter === undefined) return undefined;

  return { flow: authFlows[0]!, getter };
}

/**
 * A login rather than a logout.
 *
 * Both are `kind: 'auth'` and the distinction is not recorded, so it is read
 * from the name. Getting this wrong would open every test by signing out.
 */
function isLogin(flow: FlowEntry): boolean {
  return /login|signin|sign-in|authenticate/i.test(flow.exportName);
}
