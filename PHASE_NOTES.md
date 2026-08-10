# PHASE_NOTES.md

Running log of deviations, additions, and open questions per phase.

---

## Phase 0 — Foundation

**Status:** COMPLETE — schemas signed off and locked 2026-08-10.
**Date:** 2026-08-10

### Exit criteria — evidence

| Criterion                                          | Result                                                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `pnpm build` clean                                 | ✅ `tsc -p tsconfig.build.json` exits 0                                                                |
| `pnpm lint` clean                                  | ✅ `eslint .` exits 0, 0 warnings                                                                      |
| `pnpm test` green                                  | ✅ **98 tests across 15 files** pass                                                                   |
| `pnpm format:check` clean                          | ✅ prettier clean                                                                                      |
| `flint --help` lists all 8 commands                | ✅ `init, explore, index, plan, generate, verify, run, ci` (+ `hello-llm` smoke)                       |
| `flint init` produces a valid project              | ✅ 13 files, `{{baseUrl}}`/`{{projectName}}` substituted                                               |
| Re-running `init` never clobbers                   | ✅ TTY → prompt; non-TTY → skips existing (user edit preserved); `--force` overwrites; `--yes` accepts |
| `hello-llm` fails actionably with no API key       | ✅ `error: ANTHROPIC_API_KEY is not set.` + hint (no stack trace)                                      |
| Invalid config → friendly zod error naming the key | ✅ names `baseUrl`, `envClass`, etc.; hint `Fix the "baseUrl" key.`                                    |
| `hello-llm` succeeds against the real API          | ✅ verified live — see below                                                                           |

**Live LLM verification (2026-08-10, operator machine):** `flint hello-llm`
completed a real structured call — model `claude-haiku-4-5-20251001`, 89 input /
35 output tokens, 1309 ms, `stop_reason: end_turn`, response schema-validated.
This exercises the full chain: prompt template loader → `AnthropicProvider` →
structured-output validation → pino call logger. **All Phase 0 exit criteria are
now met with evidence.**

### Environment note — TLS-inspecting proxies

The first live run failed with `SELF_SIGNED_CERT_IN_CHAIN`. Cause was a
corporate TLS-inspecting proxy (Cloudflare Zero Trust Gateway): `curl` succeeded
because macOS trusts the proxy's root CA via the system keychain, while Node
ships its own CA bundle and ignores the keychain. Not a Flint defect.

Fix on Node ≥ 22.15: `export NODE_OPTIONS=--use-system-ca`. On older Node,
export the roots and set `NODE_EXTRA_CA_CERTS`. Never set
`NODE_TLS_REJECT_UNAUTHORIZED=0` — it disables verification process-wide.

Phase 1 will hit the same wall: Playwright downloads Chromium over HTTPS and the
browser must trust the same proxy to reach the target app. Contributors behind
an inspecting proxy should put the CA setting in their shell profile.

### Deviations from the master plan / kickoff

- **None** in structure or scope. One location note: the master plan lives at
  `reference/docs/flint-master-development-plan.md` (not `docs/`), and the
  kickoff at `PHASE_0_KICKOFF.md`. Left as-is; treated `reference/docs/...` as
  the single source of truth.

### Build/stack choices (within the LOCKED stack)

- **Build:** plain `tsc` (NodeNext ESM, `.js` import specifiers) — no bundler,
  keeps output standard and debuggable. `pnpm build` uses `tsconfig.build.json`
  (excludes tests).
- **zod v3** (not v4) for stable error-message shape, which the rejection tests
  assert on.
- **jiti** added as a dependency to load `flint.config.ts` (TypeScript config)
  at runtime for `loadConfig`.
- **eslint flat config** (v9) + `typescript-eslint` + `eslint-config-prettier`.
- `exactOptionalPropertyTypes: false` in tsconfig so `foo?: T` fields accept an
  explicit `undefined` without ceremony. Flag if strict optionality is wanted.
- Logger: `pino` JSON only (no `pino-pretty`) to avoid an extra runtime dep in
  Phase 0.

### Schema additions beyond the abridged B4 (require review)

B4 is explicitly abridged ("..."); the kickoff permits obviously-needed
additions if listed here. All schemas are `.strict()` (unknown keys rejected).

**config.ts** (B4 only names the fields at a high level):

- `suiteDir` (default `e2e`), `kbDir` (default `kb`).
- `auth` discriminated union: `none | storageState | loginScript | credentials`
  (default `{ mode: 'none' }`).
- `explorer`: `mode` enum `crawl | agent | crawl-then-agent` (default `crawl`;
  agent modes are V2 — enum stubbed now, no agent logic built), `urlPatterns`
  `{ include, exclude, normalize[] }`, `maxPages` (50), `maxDepth` (5),
  `dangerousActionPatterns` (default `['logout','delete','submit','pay','remove']`),
  `i18n` (false), `roles` ([]), `captchaPatterns` ([]),
  `waitStrategy` enum `networkidle | domcontentloaded | load` (default `networkidle`).
- `models`: `{ planner, coder, repair }` — **required, no default**.
- `dialect` (default `playwright-pom`).
- `tokenBudgets`: `{ plan: 60000, generate: 40000, repair: 30000 }` (defaults).
- `debug`: `{ logPrompts: false, verbose: false }`.
- `envClass` enum includes `production` so later phases can _refuse_ it (D1/E1).

**screen-model.ts**:

- Top-level `ScreenModel` container: `version, baseUrl, role?, capturedAt,
appVersionHint?, pages[]` (B4 sketched only Page/Element/SelectorCandidate).
- `Element.framePath?` (iframe support, Phase 1).
- `Page.lang?` (i18n), `Page.role?` (multi-role), `Page.unreachable?` (CAPTCHA/bot).
- `ReachedVia` = discriminated union `LinkRef | FlowRef` (`FlowRef.step?`).
- `BoundingBox`, `ElementStates` broken out as explicit sub-schemas.
- Selector `strategy` enum sourced from the LOCKED `SELECTOR_STRATEGIES` const.

**test-plan.ts**:

- `TestCase.status` adds `blocked` (+ `blockedReason`), because Phase 3 requires
  emitting blocked cases; `prerequisites?`, `acceptanceRefs?`.
- `Assertion.kind` enum: `visible | hidden | text | url | count | value | toast`;
  `Assertion.expected` = `string | number | boolean`.
- `TestPlan.openQuestions?` (Phase 3 "ask, don't guess").
- Cross-field `superRefine`s: assert⇒assertion, fill/select⇒value,
  skipped-duplicate⇒duplicateOf, update-existing⇒duplicateOf, blocked⇒blockedReason.
- These forward-looking fields were added **now on purpose**: schemas lock after
  Phase 0, and Phase 3 explicitly needs them. **Approved by the operator on
  2026-08-10** — see "Open questions" below.

**suite-index.ts**:

- Added `generatedAt`, `suiteDir`; `PageObject` carries per-method and aggregate
  `selectorsUsed` (for Phase 6 drift mapping); `Fixture`/`DataFactory` = `{ name, file }`.

**run-report.ts**:

- Top-level `runId, startedAt, finishedAt, baseUrl, envHealthy, summary, tests`.
- `TestResult.artifacts?, possibleAppDefect?, durationMs?`; `RunSummary` sub-schema.
- Cross-field `superRefine`: `failed` ⇒ `failureClass`.

**kb.ts**:

- `id` constrained to kebab-case; `priority` default `p1`; `tags` default `[]`;
  added `acceptanceCriteria?, negativeCases?, dataNeeds?, status` (draft/ready/generated).

### LOCKED selector ranking

Defined once in `src/shared/selector-ranking.ts` (exported constants + pure
`scoreSelector`): testid 100, role 85, label 75, placeholder 65, text 55, css 30;
non-unique × 0.3. Table-driven test asserts every strategy in both states.

### Open questions — ALL RESOLVED (schemas signed off 2026-08-10)

1. ~~**Forward-looking schema fields**~~ — **approved.** The four case statuses,
   `openQuestions`, `acceptanceRefs`, and the explorer agent-mode enum stay.
2. ~~**`hello-llm` default model**~~ — **resolved.** Planner and repair default
   to `claude-opus-5`, coder to `claude-sonnet-5`; the scaffolded
   `flint.config.ts` documents the per-role tradeoff so users can tune it.
   `hello-llm` keeps `claude-haiku-4-5` — it only proves wiring, so Opus tokens
   there are waste; override with `--model` or `ANTHROPIC_MODEL`.
3. `exactOptionalPropertyTypes: false` — accepted as-is.
4. ~~**`update-existing` has no enforced target**~~ — **resolved: option (a).**
   `update-existing` now requires `duplicateOf` naming the test it updates,
   exactly as `skipped-duplicate` does. Message: `update-existing case requires
'duplicateOf' naming the test it updates`.
5. ~~Scaffolded config imports `defineConfig` from `'flint'`~~ — **resolved:**
   type-only import + `satisfies`, erased at load time.

### Final schema change before lock — `TestCase.prerequisites`

The operator asked for a way to express "this case needs test data or a config
value before it can run." Reviewed and implemented as a **separate axis, not a
fifth status**, for one reason: `new` / `skipped-duplicate` / `update-existing`
/ `blocked` are mutually exclusive answers to _"what should the Emitter
write?"_ — while "needs setup" answers _"can this run yet?"_ A case can be
`new` **and** need data, or `update-existing` **and** need data. A fifth status
would force a choice between the two and the Emitter needs both.

`TestCase.dataNeeds: string[]` (informational only) is **replaced** by:

```ts
prerequisites?: Array<{
  kind: 'data' | 'config' | 'external-service' | 'manual';
  description: string;   // "a user with at least 3 completed orders"
  key?: string;          // config key / env var, when kind is 'config'
}>
```

`kb.ts`'s own `dataNeeds` is untouched — that is human-authored feature-spec
frontmatter (planner _input_); `prerequisites` is planner _output_ per case.

**Emitter contract (Phase 4), evaluated in order:**

1. `blocked` → `test.fixme()` carrying `blockedReason`
2. `prerequisites` non-empty → the COMPLETE test, emitted as `test.skip()` with
   a `@needs-setup` tag and each prerequisite as a comment
3. otherwise → a live test

Rule 2 is what protects Phase 5: a skipped test never runs, so the repair loop
cannot burn iterations "fixing" correct code, and a missing fixture can never be
misreported as a possible application defect.

### SCHEMAS LOCKED

All schemas in `src/schemas/` are signed off as of 2026-08-10 and are now the
frozen contract. Any further change requires explicit human approval per
CLAUDE.md rule 4. Phase 1 is unblocked.

### PR review fixes (PR #1, pre-merge)

A code review of PR #1 found 8 issues; all fixed before merge:

1. `parseJsonLoose` now tries a direct `JSON.parse` before stripping code
   fences (valid JSON containing ``` in string values was being mangled).
2. The LLM call record is now ALWAYS emitted at info level; `logPrompts` only
   attaches the prompt field (previously it silently rerouted the whole record
   to debug).
3. Scaffolded config: type-only import (see open question 4 above).
4. `structured()` detects `stop_reason: max_tokens` and throws an actionable
   truncation error instead of a misleading validation retry.
5. `FakeProvider` record mode without `delegate` or `fixtureDir` now fails fast
   at construction (before any paid delegate call).
6. Corrupt/misshapen fixture files raise a `ProviderError` naming the file.
7. `packageRoot()` verifies `name === "flint"` instead of taking the first
   `package.json` found walking up.

### Post-merge fixes

8. **Connection-failure diagnostics.** `hello-llm` reported only the SDK's bare
   `"Connection error."` on any network failure. `describeRequestFailure()` now
   walks the error's `cause` chain (bounded, cycle-safe), extracts the Node
   error code, and maps known codes to the thing to check — DNS/VPN,
   `HTTPS_PROXY`, or `NODE_EXTRA_CA_CERTS` for TLS-inspecting proxies. This is
   what identified the Cloudflare Gateway interception above. 7 tests.

### Product rename: TestGen → Flint

Requested by the operator after Phase 0 merged; done now because Phase 0 is the
entire codebase and the cost only grows with each phase. 173 occurrences across
33 files. **Pure rename — no behavior, schema shape, or control flow changed.**

| Surface           | Before                   | After                  |
| ----------------- | ------------------------ | ---------------------- |
| Package / CLI bin | `testgen`                | `flint`                |
| Project config    | `testgen.config.ts`      | `flint.config.ts`      |
| Artifact dir      | `.testgen/`              | `.flint/`              |
| Managed marker    | `/* @testgen:managed */` | `/* @flint:managed */` |
| Suite tag         | `@testgen`               | `@flint`               |
| Error classes     | `TestGenError`, …        | `FlintError`, …        |
| Config types      | `TestGenConfig*`         | `FlintConfig*`         |
| Master plan file  | `testgen-master-…md`     | `flint-master-…md`     |

Schema **field names and shapes are untouched** — only the exported TypeScript
identifiers and the config filename changed, so the CLAUDE.md rule-4 lock on
schema contracts is not violated in substance. Recorded here as the operator's
explicit approval of the identifier rename.

Also corrected: CLAUDE.md pointed at `docs/…-master-development-plan.md`; the
file actually lives at `reference/docs/`. Pointer now matches reality.

Gates after rename: build, lint, format clean; 91 tests green; `flint --help`,
`flint init`, and config load re-verified end to end.

### STOP

Per the kickoff: Phase 0 ends here. **Schemas are presented for human review;
Phase 1 does not start until they are approved.**
