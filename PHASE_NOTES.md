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

---

## Phase 1 — Explorer

Built in four commits. Phase 0 files were not modified except the two wiring
points noted under "Frozen-file touches" below.

### Exit criteria — evidence

Measured by `src/explorer/exit-criteria.test.ts`, which builds a 30-page fixture
app (26 server-rendered pages + 4 client-rendered SPA routes that paint 120 ms
after load) and reports real numbers rather than asserted ones.

| Criterion (master plan Part C, Phase 1)   | Required             | Measured                             |
| ----------------------------------------- | -------------------- | ------------------------------------ |
| 30-page crawl completes                   | < 5 min              | **47.2 s**                           |
| Stored top-candidate selectors re-resolve | ≥ 95%                | **192/192 = 100.0%**                 |
| Elements with a verified-unique selector  | (ceiling on Phase 4) | **100%** on the content-page fixture |
| `pnpm test`                               | green                | **345 tests, 26 files**              |
| `pnpm build` / `pnpm lint`                | clean                | clean                                |

**Not verified in this environment: the two public demo apps.** The master plan
asks for a full Screen Model against saucedemo.com plus one SPA (Conduit or
similar). The sandbox this phase was built in has an egress proxy that refuses
CONNECT to both (`403`, verified with curl), so those runs must be done on the
operator's machine. Everything they would exercise is covered by local fixtures
serving the same shapes over real HTTP with a real browser — including the
login wall, the SPA render delay, and session expiry — but the demo-app runs
remain an open item, listed under "Open items" below.

### Selector-ranking correction found by the exit-criteria run

The first exit-criteria run measured **93.75%**, below the 95% gate. Every
failure was on an SPA route. Cause: `validateModel` navigated with
`waitUntil: 'domcontentloaded'` and read the page immediately, while the
crawler waits for DOM stability before extracting. The validator was therefore
measuring an empty shell and reporting every selector on it as drift — which
would have made `flint explore --validate` useless against any React/Vue app,
and would have made the Phase 1 gate unpassable for the wrong reason.

Fix: the validator now calls `waitForDomStable` after `goto`, exactly as the
crawler does. Re-measured at 100.0%. Regression test:
`validator.test.ts > waits for client-rendered content instead of reporting it
as drift`, which serves a shell that paints after 150 ms.

### Scenario coverage (master plan Phase 1 list)

| Scenario                         | Where                                                                                                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SPAs / client-side routing       | `wait.ts` — `waitForDomStable` (node-count + body-text fingerprint, polled to a timeout) and `recordRoutes` (`framenavigated` + `page.url()` for history-API pushes) |
| Login walls mid-crawl            | `crawler.ts` — one re-auth via the caller-supplied `reauth` callback, then resume; otherwise stop with a partial model. `auth.ts` — `reauthenticate()`               |
| Login wall at the _entry_ page   | `crawler.ts` — `diagnoseLoginWall`, surfaced by the CLI with a config snippet (see below)                                                                            |
| Infinite/parameterised URLs      | `url-policy.ts` — `normalize` rules, `dedupeKey`                                                                                                                     |
| Modals/menus needing interaction | `interaction-pass.ts` — open/snapshot/close, one interaction deep                                                                                                    |
| iframes                          | `extractor.ts` — same-origin child frames flattened with `framePath`; cross-origin skipped                                                                           |
| Shadow DOM                       | Playwright locator APIs throughout; no raw DOM walks                                                                                                                 |
| i18n apps                        | `<html lang>` recorded per page; `I18N_TEXT_DEMOTION` in the ranker                                                                                                  |
| Destructive links                | Crawler never clicks — `goto` on vetted hrefs only. The interaction pass is the one place that clicks, and it is gated on `explorer.dangerousActionPatterns`         |
| CAPTCHAs / bot detection         | `explorer.captchaPatterns` → page skipped, crawl continues                                                                                                           |
| Multi-role apps                  | `--role`, `model.<role>.json`, pages tagged                                                                                                                          |

### Login-wall diagnostic (added after two rounds of operator confusion)

Running `flint explore` against an app whose front door is a login screen
reported "Explored 1 page" — indistinguishable from a genuine one-page app.
Twice this had to be explained by hand. The tool now explains itself: when a
password field is visible on the entry page, `CrawlResult.loginWallSuspected`
is set and the CLI prints a warning naming the configured `auth.mode` and, when
it is `none`, a ready-to-paste `auth: { mode: 'credentials', … }` block.

### Flow-script format (defined here — the master plan does not specify one)

`<kbDir>/app/flows/*.md`: optional `---` frontmatter (`id`, `description`;
minimal `key: value` reader, not a YAML parser) plus the **first** `ts`/`js`
code fence. The fence exports `default async (page, flint) => {…}` where
`flint` is `{ baseUrl, capture(label?) }`. Each `capture()` snapshots the
current state as `reachedVia: { kind: 'flow', flowId, step }` — the schema's
existing `FlowRefSchema.step` field is exactly this index. A flow that never
calls `capture()` is snapshotted once where it ends. A throwing flow is
reported by id and file; the remaining flows still run. Example shipped at
`templates/init/kb/app/flows/example.md`.

Only the first fence is used, deliberately: a flow is one script, and
concatenating fences would make execution order depend on prose layout.

### Deviations and simpler-option calls (CLAUDE.md rule 7)

1. **Interaction-pass provenance is not persisted.** The pass knows which
   trigger revealed which elements, but `ElementSchema` is `.strict()` and
   LOCKED, so revealed elements are merged into the page's `elements` array
   with no record of the opener. Consequence: Phase 4 could emit a reference to
   a menu item without emitting the click that opens the menu.
   **Requested schema change (needs human approval, rule 4):** add
   `Element.revealedBy?: { openerElementId: string }`. Wiring it is a two-line
   change in `crawler.ts`; `InteractionPassResult.outcomes` already carries the
   relationship in-process. Until then, prefer `--no-interaction-pass` if a
   Phase 4 run starts emitting menu-item references that fail.
2. **Flow pages merge into crawled pages by page id (normalized URL).** A flow
   that reaches "/cart with items" folds its elements into the same page as the
   crawled empty "/cart", taking the union. The Screen Model has no notion of
   per-state pages in V1. **Open question:** should page identity include state?
   That is a schema change and a much larger design question — flagged, not taken.
3. **Screenshots are stored as a path relative to the model file**
   (`screenshots/<pageId>.png`) rather than the absolute write path, so a
   committed Screen Model is not tied to one machine's layout.
4. **`waitForDomStable` fingerprint is node count + body text length**, not a
   full DOM hash. It is sensitive to what matters (elements appearing, content
   filling in) and ignores attribute churn from animations, which would
   otherwise never settle.
5. **`isDangerous` is a literal case-insensitive substring match.** "Log out"
   does not match the default pattern `logout`; this is documented in the
   table-driven test rather than silently normalised, because a fuzzy match here
   would be a safety property nobody can predict.

### Frozen-file touches

- `tsconfig.json` (Phase 0): `"lib": ["ES2022", "DOM", "DOM.Iterable"]`. Required
  for `locator.evaluate` callbacks, which run in the browser and need DOM types.
  Already flagged in the Phase 0 section.
- `templates/init/kb/app/flows/example.md` is a **new** file in the Phase 0
  scaffold directory. Rule 2 permits later phases to add files; no existing
  template was modified.

No other Phase 0 file was changed.

### New config surface

None. The whole phase runs on the LOCKED `ExplorerConfigSchema` — including
`dangerousActionPatterns`, which existed but had no consumer until the
interaction pass. New behaviour is controlled by CLI flags instead:
`--no-interaction-pass`, `--no-flows`, `--flow <id...>`.

### Defect found while preparing the operator test run

**Query-parameterised URLs produced duplicate page ids.** Page identity is the
normalized _path_ (`pageId(urlPattern)`), while the crawl frontier dedupes on
path **+ query**. So `/item.html?id=1..3` were three frontier entries that each
became a page — three entries in `model.pages` sharing one id. `diffModels`
indexes by id, so it silently kept only the last. saucedemo's product pages are
exactly this shape (`/inventory-item.html?id=0..5`), so the first real demo-app
run would have produced six colliding pages.

Fixed in two places: `enqueueTargets` now skips a URL whose prospective page id
is already claimed (so the five redundant page loads never happen), and the
capture path drops a page whose id is already present (covering redirects that
land on a claimed pattern). Both record `reason: 'duplicate-pattern'` in
`skipped`, so the collapse is reported rather than silent. Tests:
`collapses query-parameterised URLs into one representative page` and
`never emits two pages sharing an id`.

### Pre-test review pass (operator-requested) — three defects found and fixed

A line-by-line walk of the implementation against the master plan's Phase 1
scenario list, done before handing the build over for local testing. All three
defects shared a shape: correct against the fixtures they were built with,
wrong against a real app the plan explicitly names.

1. **Anonymous crawls aborted on in-app login pages.** The session-expiry
   check fired on any password field at depth > 0, regardless of auth mode.
   Conduit links `/login` and `/register` from every navbar; crawled with
   `auth.mode: "none"`, hitting either page triggered "session expired", the
   CLI's ever-present reauth callback threw (mode none cannot re-auth), and the
   whole crawl stopped with a partial model. A session cannot expire if none
   was ever established — the check is now gated on `auth.mode !== 'none'`.
   Test: `treats an in-app login page as content when crawling anonymously`.

2. **The validator reported every iframe element as broken.** Elements inside
   same-origin iframes are verified in their child frame and stored with
   `framePath`, but `validateModel` resolved everything in the main frame —
   guaranteed 0 matches, on every run, for exactly the elements the plan's
   iframe scenario exists for. The validator now resolves each element in its
   recorded frame (matched by frame name or URL; a missing frame is itself
   drift). Test: `resolves elements inside same-origin iframes in their own
frame`.

3. **Credential login failed falsely on SPA logins.** After submitting, the
   password field was checked _instantly_. An SPA login submits over XHR and
   swaps the form out client-side, so the field is still visible at
   `domcontentloaded` — every SPA login was declared failed. Works on
   saucedemo (real navigation), broken on the app class Phase 1 targets. The
   check is now a bounded settle wait (5 s, 250 ms poll) for the password
   field to disappear. Cost on genuinely bad credentials: the failure now
   takes 5 s to report instead of 0 — acceptable for a correct verdict.
   Test: `waits out an SPA login that swaps the form without navigating`.

Post-review gates: 330 tests, 26 files; build, lint, format clean.

### First real demo-app run (operator, saucedemo) — four defects

The run proved determinism (`--diff` clean on a live site), flow replay (the
`populated-cart` flow captured 13 elements on a cart the crawl cannot reach),
and 330 tests green. It also failed its headline step, for four reasons.

1. **The crawl restarted at `baseUrl` after logging in.** `saucedemo.com/` _is_
   the login page and keeps serving the sign-in form to authenticated visitors.
   So: login succeeded, the auth bootstrap closed its page and threw away the
   URL it had landed on (`/inventory.html`), the crawl restarted at `baseUrl`,
   and the model contained one page — the login screen — under a "session did
   not carry into the crawl" warning. Every component worked; the entry point
   was wrong. `createAuthenticatedContext` now returns `AuthSession { context,
landingUrl }`, and the CLI starts the crawl from `landingUrl` when it is
   same-origin with `baseUrl` (`--url` still wins). Tests in
   `login-at-root.test.ts` model the saucedemo shape exactly.

2. **`baseUrl` would then have been dropped from the model.** Starting inside
   the app means nothing links back to the sign-in page, and a test generator
   that cannot see the login screen cannot generate a login test. `CrawlOptions.
alsoCrawl` seeds extra depth-0 entry points; the CLI passes `baseUrl` when
   the entry point was redirected. The entry-page login-wall diagnostic now
   fires only for the _first_ captured page, not for every depth-0 seed.

3. **The app's own sign-in page read as session expiry.** With `alsoCrawl`
   seeding `/`, the depth-0 exemption alone was not enough — any app linking
   its own `/login` would trip the expiry path once authenticated. `knownLoginUrl
(config)` exposes the configured login URL and the crawler exempts it by
   origin+path. A login wall _elsewhere_ still means expiry, as before.

4. **A dead SPA URL reported success.** `demo.realworld.build` no longer
   resolves. The crawl captured 0 pages, wrote an empty model over the stored
   one, and exited 0 — and `--validate` then reported "PASS: resolve rate
   100.0%" against it, because 0/0 was defined as 1. Both now fail loudly: a
   0-page crawl prints the nav failure and refuses to overwrite the stored
   model, and `--validate` fails when `selectorsChecked === 0` rather than
   reporting 100% of nothing.

Also fixed: the scaffolded example flow **ran on every new project** and was
reported as a failed flow when it could not reach the app. Flow discovery now
skips `_`-prefixed files and the template ships as `_example.md`, documented as
"copy me, do not edit in place".

The SPA exit criterion is still unverified — the demo URL was dead, not Flint.
Post-fix gates: 335 tests, 27 files; build, lint, format clean.

### Second demo-app run — the crawler could not see saucedemo's links

The entry-point fix worked: the crawl now starts at `/inventory.html` and
captures 28 elements there. But it then found **nothing to visit next** —
2 crawled pages, and an empty `skipped` list, meaning not one link was even
considered and rejected. Three separate causes, all real.

1. **Relative hrefs resolved against `baseUrl`, not the page they were on.**
   `decideScope` called `resolveUrl(href, options.baseUrl)`, so `href="item"`
   found on `/products/list` became `/item`. Invisible on saucedemo (whose
   `baseUrl` is the root) and silently wrong on any app with nested paths.
   `decideScope` now takes the containing page URL.

2. **Hash routes were discarded.** `resolveUrl` rejected every `#…` href and
   `dedupeKey`/`normalizePath` dropped fragments, so a hash-routed SPA
   (`#/login`, `#/settings` — several Conduit builds) collapsed to a single
   page. A fragment starting `#/` is now treated as part of page identity;
   `#section` is still an anchor and still ignored.

3. **Links with no navigable href were invisible.** saucedemo is React: its
   product, cart and menu links are `<a href="#">` with click handlers that
   call the router. A crawler that follows hrefs finds zero. The routes
   themselves are ordinary URLs that respond to `goto` — the crawler just
   never learned them.

   `route-discovery.ts` clicks such a link once, records where the app routed
   to, restores the page, and hands the URL to the crawler to visit _by
   navigation_. The safety model is unchanged in substance: the crawler still
   only `goto`s vetted URLs, and this is the master plan's sanctioned bounded
   -click escape hatch, restricted to link elements (never buttons), visible
   ones only (a closed burger menu is never clicked), and filtered through
   `dangerousActionPatterns`.

   It runs **only on pages that offered no in-scope href at all**, so
   server-rendered apps pay nothing for it. `--no-route-discovery` disables it.

Post-fix gates: 346 tests, 28 files; build, lint, format clean.

### Open items carried into Phase 2

1. Run `flint explore` against saucedemo.com and one SPA (Conduit) from a
   machine with egress, and record the two Screen Models. This is the only
   Phase 1 exit criterion not verified here.
2. Approve or reject `Element.revealedBy` (deviation 1 above).
3. Decide whether page identity should include state (deviation 2 above).

---

### Open questions from the saucedemo run (NOT resolved)

Two findings from the operator's live run that are recorded rather than fixed.

**1. `--diff` is not clean against saucedemo, and I could not reproduce it.**
Two runs of identical code, minutes apart, reported every element on three
pages as changed under `selectorCandidates`. After live verification the only
field that can vary is `unique` (and the score derived from it), so this means
`locator.count()` returned different numbers between runs.

Two things were done, neither of which is a proven fix:

- The differ now names the individual candidate and direction
  (`[role] button[name="Go"] unique true→false`) instead of the bare field
  name. On a real app "selectorCandidates changed" cannot distinguish app drift
  from flaky verification; this output can. Phase 6 needs the same detail to
  answer "which tests will this UI change break?".
- Verification now takes **two readings** (parallel, ~120 ms apart) and requires
  them to agree; disagreement resolves to non-unique. That is the safe
  direction — `pickBest` only offers verified-unique candidates to the Emitter,
  so an unstable selector is excluded rather than becoming a flaky test.

**Honesty note:** the confirm-read was justified on its own terms, _not_ by a
reproduction. An attempt to build one failed: a fixture that re-renders after
load does not flake, because `waitForDomStable` settles before extraction
begins — which is exactly that wait's job. Producing a genuine flake requires a
DOM that never settles, and a test built on that would itself be flaky. The
test file says so in its header rather than implying coverage it lacks.

**RESOLVED against the live app (operator run, 2026-08-11).** Two consecutive
`flint explore` runs against saucedemo now report `No changes.` — 4 pages,
55 elements, 55 verified-unique, identical both times. The phantom drift was
flaky single-read uniqueness verification, and the confirm-read removes it.
This is evidence from the real app that raised the symptom, not from a
fixture.

**2. `--validate` reported 96.4%, and the two "broken" selectors are not drift.**
Both live on `/cart.html`: `button[name="Remove"]` and
`link[name="Sauce Labs Backpack"]`. Both were captured by the `populated-cart`
flow, which adds an item first. Validation navigates to an _empty_ cart, where
neither exists. The model asserts elements that only exist in one state.

This is the third symptom of one root cause, already recorded above as
deviation 1 (interaction-pass provenance) and deviation 2 (flow/crawl page
merging): **the Screen Model records what an element is, never how it came to
exist.** One optional additive field would resolve all three:

```ts
Element.provenance?:
  | { kind: 'page' }                                  // present on load
  | { kind: 'revealed'; openerElementId: string }     // needs a click first
  | { kind: 'flow'; flowId: string; step: number }    // needs a flow first
```

With it: the validator skips state-dependent elements instead of reporting
false drift, and Phase 4 emits the precondition instead of a test that fails on
first run. Without it, Phase 4 must either ignore flow- and interaction-derived
elements entirely (throwing away real coverage — the operator's cart flow
becomes decorative) or emit tests that fail.

**Status: APPROVED by the operator, 2026-08-11.** This is the only change to
`src/schemas/screen-model.ts` since the schemas were locked, and the only
schema change of any kind since Phase 0 sign-off.

Shipped as:

```ts
Element.provenance?:
  | { kind: 'page' }                                  // present on page load
  | { kind: 'revealed'; openerElementId: string }     // click the opener first
  | { kind: 'flow'; flowId: string; step: number }    // replay the flow first
```

Optional and additive — Screen Models written before it still parse, and an
absent value means `page`.

What it changed in practice:

- **The interaction pass now resolves its trigger to a real captured element**
  before clicking, matching on test id, then DOM id, then an unambiguous
  accessible name. A trigger that matches nothing in the model is skipped with
  `opener-not-in-model` and its contents are discarded: nothing downstream
  could click it, so whatever it reveals is unreachable. `openerElementId`
  therefore always references an element that exists, never a dangle.
- **Flow captures stamp `{kind:'flow', flowId, step}`** on every element, so a
  state-dependent element carries the flow that produces it.
- **`--validate` skips elements with a non-`page` provenance** and reports them
  as `Needs a precondition: N` instead of counting them as drift. This is the
  direct fix for the operator's 96.4%: both "broken" selectors were flow
  captures. A test pins that the exemption is not a blanket amnesty — a
  genuinely broken page-load selector is still reported.
- **Phase 4 can now emit the precondition** rather than referencing a menu item
  or cart button with no way to reach it.

## Phase 2 — Suite Indexer

Phase 1 files are frozen from here. Phase 2 adds `src/indexer/` and one CLI
command; the only edits to existing files are the two designated wiring points
(`src/cli/index.ts` registration, and removing `index` from the Phase 0 stub
list now that it is real).

### Exit criteria — evidence

| Criterion (master plan Part C, Phase 2)              | Required | Measured                |
| ---------------------------------------------------- | -------- | ----------------------- |
| Index a 50-file suite                                | < 10 s   | **25 ms**               |
| Distinguishes generated / hand-written / hand-edited | correct  | 3-way test, all classes |
| Empty suite produces a valid empty index             | valid    | schema-valid, no throw  |
| No suite dir at all produces a valid empty index     | valid    | schema-valid + a NOTE   |
| `pnpm test`                                          | green    | **391 tests, 31 files** |
| `pnpm build` / `pnpm lint`                           | clean    | clean                   |

The 25 ms figure is printed by the test itself (`[exit criteria] indexed 50
files in 25ms`) rather than asserted from memory. It is three orders of
magnitude inside the budget because the scan is purely syntactic — see below.

### Design decisions

**No type resolution, ever.** `scanSuite` builds a ts-morph `Project` with
`skipAddingFilesFromTsConfig`, `skipFileDependencyResolution` and
`noResolve`. Nothing is type-checked and no lib files are loaded. Two
consequences, both wanted: the scan is ~1000× inside its time budget, and a
suite that does not compile still indexes. The plan requires the second
outright ("TS parse errors in user files: skip file, warn, continue").

**Directory layout is a hint, not a rule.** The plan is explicit that real
suites will not follow our conventions. So: any exported class is a page
object wherever it lives, any file calling `test(` or `it(` is a spec, and one
file can be both. `fixtures/` and `data/` (or `.fixture.` / `.factory.` in the
filename) select fixtures and factories. A flat single-file suite indexes
correctly — there is a test for exactly that.

**Managed-marker hashing excludes the marker line.** `withMarker` strips any
existing marker before hashing and re-stamping, so it is idempotent: writing
the marker cannot change the hash the marker records, and regenerating an
unchanged file is byte-identical. Phase 4's determinism check depends on this.
Truncated hashes in a marker are compared on the recorded length, so a
hand-shortened marker is not misread as an edit.

**Whitespace counts as an edit.** Reformatting a generated file marks it
hand-edited. Regenerating it _would_ discard that work, so the conservative
answer is the correct one.

**Marker classification reads raw bytes, not the ts-morph source.** ts-morph
normalises whitespace, which would change the hash and report every managed
file as hand-edited.

### Deviations

1. **`PageObjectMethod`, `Fixture` and `DataFactory` types are derived in
   `scan.ts`**, not exported from `src/schemas/suite-index.ts`. The schema file
   exports those _schemas_ but not their inferred types, and it is LOCKED —
   adding an export would be a change to a frozen Phase 0 file. Deriving them
   locally with `z.infer<typeof XSchema>` gives identical types and touches
   nothing frozen. If a later phase wants them centrally, that is a one-line
   frozen-file edit needing approval.
2. **Test identity in the coverage map is the test title**, not `file::title`.
   The schema types `CoverageMap` as `featureId -> string[]` with no stated
   format. Titles are what a human reads in a plan and what Phase 3 must match
   against for duplicate detection, so titles are the useful key. Recorded here
   because Phase 3 depends on the choice.
3. **A `@feature:<id>` tag covers every test in the file it appears in.** Tags
   can sit on a `describe`, on an individual test, or in the options object,
   and distinguishing which tests a file-level tag applies to would need scope
   analysis the syntactic scan deliberately avoids. Over-attribution is the
   safe direction: Phase 3 uses coverage to _skip_ duplicates, so a false
   "covered" is caught by the human reviewing the plan, while a false
   "uncovered" silently generates a duplicate test.

### Frozen-file touches

- `src/cli/index.ts` — registration line. Designated wiring point.
- `src/cli/commands/stubs.ts` — `index` removed from the stub list because it
  is now implemented. This is the intended lifecycle of that file.

No other Phase 0 or Phase 1 file was modified.

---

## Phase 3 — Planner (Stage A)

Adds `src/planner/`, one prompt template, and one CLI command. Phase 1 and 2
files are untouched except the two designated wiring points.

### Exit criteria — evidence

Measured by `src/planner/golden-specs.test.ts`, which runs five feature specs
against a fixed Screen Model with the LLM replaced by a deterministic responder.

| Criterion (master plan Part C, Phase 3)         | Required | Result                      |
| ----------------------------------------------- | -------- | --------------------------- |
| Plans reference only real Element ids           | enforced | validator refuses the plan  |
| Every acceptance criterion covered              | 5 specs  | checklist asserted per spec |
| Correctly skips cases a pre-seeded suite covers | yes      | forced `skipped-duplicate`  |
| `pnpm test`                                     | green    | **469 tests, 36 files**     |
| `pnpm build` / `pnpm lint`                      | clean    | clean                       |

The responder is not a canned blob: it parses the element ids out of the prompt
it receives and plans against them. A bug that stopped ids reaching the prompt
would surface as an empty plan rather than passing silently — which is what
makes "references only real ids" a real assertion rather than a tautology.

### Design decisions

**The LLM is bounded on both sides.** Going in, the context lists only elements
with a verified-unique selector, because Phase 4 could not emit anything else —
offering the rest invites plans that cannot be generated. Coming out, the plan
is zod-validated, every `elementRef` is re-checked against the ids actually
shown, and duplicate detection is re-run deterministically rather than trusted.
A plan that references an invented element is **refused**, not repaired: handing
a human invented tests wearing the tool's authority is the worst available
outcome.

**`blocked` cases are exempt from referential checking.** A blocked case exists
precisely because the UI is missing, so its steps may name what the spec asked
for. That is the case doing its job.

**Provenance becomes a precondition line in the prompt.** An element behind a
menu renders as `precondition: only exists after clicking element <id>`, and a
flow-captured one names its flow. This is the first consumer of the schema field
approved on 2026-08-11, and the reason it was worth adding: without it the
planner would reference a cart's Remove button with no way to reach it.

**The matcher discloses when it fell back.** With no `pages:` hint and no
keyword overlap, every page is offered as a last resort. Rendering that silently
makes a fallback list indistinguishable from a curated one, so the context now
says so explicitly and instructs the planner to emit `blocked` rather than
substitute something similar. Found while writing the `reporting` golden spec.

**Truncation order is the master plan's, literally**: spec > pages > index >
exemplars. The spec is never dropped and at least one page always survives;
what was dropped is reported in the CLI output and the rendered plan, so a thin
plan is explainable rather than mysterious.

### Deviations

1. **`yaml` added as a dependency.** Feature-spec frontmatter carries arrays
   (`pages`, `acceptanceCriteria`, `negativeCases`, `dataNeeds`), which the
   two-line `key: value` reader used for flow scripts cannot handle. The kb
   schema's own docstring calls the frontmatter YAML. Hand-rolling a YAML subset
   for a file humans edit by hand would fail in ways they could not predict.
2. **Title similarity uses stop words and crude stemming.** Plain Jaccard scored
   "User can sign in" against "User signs in" at 0.4 — a human calls those the
   same test, and the whole point of duplicate detection is to match human
   judgement. Stop-word removal plus trailing-`s` stripping brings it to 1.0
   while keeping "User can sign in" / "User can sign out" apart at 0.67.
   Negation tokens survive both, so a negative case is never collapsed into its
   positive twin — the expensive direction of this error.
3. **Coverage-map test identity is the test title** (recorded in Phase 2 and now
   depended on). `planHistoryCoverage` counts only `new` and `update-existing`
   cases: a duplicate is already represented by what it duplicates, and a
   blocked case has no test at all.
4. **`temperature: 0` for planning**, though the master plan only mandates it
   for code emission. A stable plan makes the whole pipeline reproducible, and
   there is no upside to a planner that answers differently each run.

### Frozen-file touches

- `src/cli/index.ts` — registration line. Designated wiring point.
- `src/cli/commands/stubs.ts` — `plan` removed from the stub list now that it is
  implemented. The intended lifecycle of that file.

No other Phase 0, 1 or 2 file was modified.

### Post-Phase-3 fix from the operator's first run

**A `pages: ['/']` hint selected every page.** `matchesHint` fell through to a
substring test, and every path contains a slash — so the natural hint for an
app whose login screen is at the root (saucedemo's is) silently selected the
whole model while still reporting `pages-hint`. Doubly bad: the
"no page matched" disclosure never fired either, because the pages _looked_
explicitly hinted.

`/` now means the root and nothing else: exact match on the normalized path
first, and the substring branch is skipped for a bare `/`. A hint of `/cart`
still matches `/cart.html`. Tests in `page-matcher.test.ts`, which the module
previously lacked entirely.

### Second operator run — the planner swallowed its own diagnostics

`flint plan login` reported, twice:

```
plan: invalid plan from the model  err="Anthropic API call failed (stage: plan)."
error: Could not generate a valid TestPlan after two attempts.
```

Two defects, both mine.

1. **The diagnosis was discarded.** `AnthropicProvider` puts the actionable
   half in `hint` — the cause chain, the Node error code, and advice such as
   which proxy variable to set. That machinery exists _because_ a bare
   "Connection error." wasted a round trip back in Phase 0. The planner relayed
   only `err.message`, reducing a diagnosable auth or TLS problem to one useless
   line. Provider failures are now re-thrown intact, and the retry feedback
   carries message + hint.

2. **A transport failure was retried as if it were a bad plan.** Retrying a 401
   or a TLS handshake failure cannot help; it doubles the latency and prints
   "invalid plan from the model" about something the model never saw. Only
   `StructuredOutputError` — the model wrote the wrong shape — is retried now.
   Everything else fails immediately with its cause. Tests pin both: a provider
   failure calls `structured` exactly once, a schema mismatch exactly twice.

Worth noting for later: `AnthropicProvider.structured` already retries twice
internally on schema mismatch, so the planner's outer retry makes up to four
attempts for malformed output. The outer one earns its place by feeding back the
_referential_ check, which the inner loop cannot see.

### Anchor review across Phases 0–3 (operator-requested, 2026-08-11)

A full pass over the codebase against the master plan, prompted by the third
operator run. Three fixes shipped; the standing gaps are re-confirmed below so
they cannot silently become "done".

**Fixed 1 — `claude-opus-5` rejects `temperature`, so every plan call 400'd.**
The API now answers ``temperature` is deprecated for this model` for newer
models, and the provider sent `temperature: 0` on all structured calls (the
determinism convention). `hello-llm` passed only because it uses haiku. The
provider now learns from the rejection at runtime: drops the parameter, retries
once, and remembers the model so later calls skip it up front. No hardcoded
model list — the model id is the user's choice in flint.config.ts and a list
would rot. The LOCKED "temperature 0 for code emission" rule is honoured
wherever the API accepts the parameter; where it refuses, there is nothing to
send. Tests stub the SDK boundary and pin: rejection → retry without → learned;
unrelated 400s untouched.

**Fixed 2 — re-planning a feature deduped against its own previous plan.**
`planHistoryCoverage` fed the feature's own stored plan into the coverage map,
so a second `flint plan login` would force every case to `skipped-duplicate`
with `duplicateOf` naming tests that were never generated. A re-plan supersedes
its predecessor; only _other_ features' plans are coverage. The operator would
have hit this on their second successful run.

**Fixed 3 — cross-origin iframes were skipped silently.** The plan's iframe
scenario says "skip cross-origin, log them". A page whose main content lives in
a cross-origin iframe would have indexed as "no elements" with no explanation.
The extractor now logs each skipped frame with the page it sits on.

**Standing gaps, re-confirmed (documented, not forgotten):**

| Gap                                 | Why it stands                                                                                                                                                               |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `explorer.roles[]` has no consumer  | Proper multi-role needs per-role auth; the LOCKED config schema has a single `auth` block. Needs a schema decision, not a workaround. `--role` covers manual per-role runs. |
| Closed shadow roots not detected    | The DOM offers no reliable signal (`shadowRoot === null` also means "no shadow root"). Logged-as-unreachable would be guesswork.                                            |
| `--review` prints rather than opens | Opening an editor is environment-specific; printing is the portable 90%.                                                                                                    |
| saucedemo + SPA live exit criterion | saucedemo now verified live by the operator across explore/validate/diff/index. The SPA demo app remains unverified — every public RealWorld deployment tried was dead.     |

### Open item

`flint plan` makes a real LLM call, so it needs `ANTHROPIC_API_KEY` and — on a
TLS-inspecting corporate proxy — `NODE_OPTIONS=--use-system-ca`. Verified as far
as the call boundary here (correct actionable error, exit code 1, "did you mean"
list for an unknown feature id); the end-to-end run against a live model is the
operator's to do.

### Review of the first live plan run (operator log, 2026-08-12)

`flint plan login --review` against live saucedemo and `claude-opus-5` produced
a usable plan on the first attempt: 6 cases (4 new, 2 blocked), 5 needing setup,
all 3 acceptance criteria covered, 3 open questions, 6100 in / 3873 out tokens,
42s. The temperature fallback fired as designed. Two defects came out of it —
one of them found by the planner itself.

**Fixed 1 — every `<input>` was modelled as `role: textbox`.** The planner's
first open question was, in effect, a bug report against the extractor:

> The site root exposes el-50b5011efc86 as an unnamed 'textbox' — it is assumed
> to be the Login submit control (Swag Labs renders it as an input). Please
> confirm; if it is a third input field, the Login button is missing from the
> Screen Model and every sign-in case becomes blocked.

saucedemo's Login control is `<input type="submit" value="Login">`.
`implicitRole()` mapped every input to `textbox` and `readFacts` never read
`type` or `value`, so the submit button arrived as an unnamed third text field.
The cost was not only the confusing name: for checkboxes, radios and password
fields the model carried a `getByRole('textbox', …)` candidate that cannot match
anything, and for the submit button it carried no role candidate at all.

The extractor now reads `type`, `value` and `alt`, maps input types per HTML-AAM
(submit/reset/button/image → `button`, checkbox → `checkbox`, radio → `radio`,
range → `slider`, number → `spinbutton`, search → `searchbox`, text/email/tel/url
→ `textbox`), and returns **no role** for password, file and the date/colour
family — `getByRole('textbox')` genuinely does not match those, so a role
candidate would be a selector that resolves to nothing. Button-shaped inputs take
their accessible name from `value` (falling back to the browser defaults
"Submit"/"Reset"), image inputs from `alt`. 25 table-driven cases plus six live
Chromium fixtures, including the saucedemo shape.

_Operator impact:_ element ids hash the role and name, so the next
`flint explore --diff` will legitimately report the input elements as
removed + added. That is this fix landing, not app drift. Re-run
`flint explore` once to rebuild the baseline.

**Fixed 2 — `generatedAt` was whatever the model imagined.** The plan from
2026-08-12 was stamped `2026-01-13T00:00:00.000Z`. The Stage A prompt asked the
model for the timestamp, and a model has no clock. `featureId`,
`screenModelVersion` and `generatedAt` are facts about the run, so the planner
now overwrites all three after validation; the prompt (v2) still lists them so
the schema validates on the first attempt, and now says outright that Flint
replaces them. Anything downstream that reasons about plan age — staleness
against the Screen Model, "was this re-planned after the crawl" — was reading
fiction until this.

**Not defects, recorded so they are not re-litigated:** the two blocked cases
are correct behaviour. saucedemo's error banner only exists after a failed
submit, so it is genuinely absent from a crawl of the initial state; the planner
blocked rather than inventing an element id, which is the guarantee Phase 3 is
built on. Reaching it needs a flow script (Phase 1 feature, operator's call).

## Phase 4 — Emitter (Stage B)

### Decision: Stage B is deterministic, not model-driven

The master plan says "temperature 0 for Stage B", which anticipated an LLM
writing the TypeScript. It is written as a pure transform instead.

The reason is that the TestPlan is already a complete, validated instruction
set: every step names an action, an element id that provably exists, and a
value, and Phase 3 refuses any plan where that is not true. Turning that into
Playwright code is mechanical. Doing it mechanically is what buys the three
things Phase 4 is actually judged on — byte-identical regeneration, a 100%
compile rate, and selectors that are exactly the ones exploration verified. A
model in this position could only contribute naming flair, and would put all
three at risk. CLAUDE.md rule 7 (prefer the simpler deterministic option,
record the question, continue) points the same way.

**Open question for the human:** if generated code should read more like a
particular team's hand-written style than a template can manage, the place to
add a model is behind the `Dialect` interface — a `llm-pom` dialect alongside
`playwright-pom`, not a rewrite of the emitter. Nothing in Phase 4 forecloses
that.

### Degradation ladder (from the LOCKED TestPlan schema)

In order, first match wins:

1. `status: blocked` → `test.fixme()` carrying `blockedReason`.
2. Any step's element has no verified-unique selector → `test.fixme()` naming
   the element ids. This is core principle #1 at the last moment before code
   exists: `pickBest` returns nothing, so nothing is emitted.
3. Any step's element sits inside an iframe → `test.fixme()`. See below.
4. `prerequisites` non-empty → the COMPLETE test, emitted as `test.skip()` with
   each prerequisite as a comment.
5. Otherwise → a live test.

### Known gap: iframe-hosted elements

The extractor verifies uniqueness _inside_ the frame. The selector that
addresses the frame itself (`frameLocator(...)`) was never verified, and
`framePath` records a frame name or URL, which does not map reliably onto a
selector. Emitting one would break the guarantee that every emitted selector was
confirmed against the live page, so a case touching an iframe element degrades
to `test.fixme()` with that reason.

Fixing it properly means having the extractor verify and record a selector for
the frame element itself — a Phase 1 change to a frozen file, so it is recorded
here rather than done. No demo app in the benchmark set uses iframes.

### The compile gate runs before writing, and admits when it cannot run

`tsc --noEmit` runs over a scratch copy of the suite (existing files + pending
ones) under `.flint/gate/`, so a page object and the spec importing it are
checked together, and a failed generation leaves the suite untouched.

Two cases where it declines to run rather than reporting a false result:

- the suite's `tsconfig.json` uses `extends` with a relative path, which would
  resolve to nothing from the scratch directory;
- every diagnostic is a missing bare module or missing `types` entry, which
  means the suite's own dependencies were never installed. Reporting that as
  "the generated code is wrong" would send a user hunting a bug that is not
  there. A missing _relative_ import is still reported as our bug, because it
  is one.

In both cases `ran: false` is returned so no caller can mistake the skip for
evidence that the code compiles.

### Determinism

Every identifier and filename comes from `src/generator/naming.ts`. Names derive
from Screen Model facts; collisions break by shortest numeric suffix in a fixed
order; the fallback for an unnamed element is its content-derived id, never a
positional index — so reordering the DOM cannot churn the output. Locator
properties are sorted by the name they will get, with the element id as
tiebreak, which keeps the ordering total.

The writer reports a byte-identical file as `unchanged` and does not rewrite it,
which is what makes the determinism guarantee visible in `git status` rather
than only in a test.

### Page-object reuse across features (exit criterion, found by testing it)

"No duplicate page objects across two features touching the same page" is a
Phase 4 exit criterion, and the first cut failed it — quietly, in the worst way.
Generating `login` wrote a `HomePage` holding `loginButton`; generating `search`
then overwrote the same file with a `HomePage` holding only `searchInput`. The
file is managed, so the writer replaced it without complaint, and
`login.spec.ts` was left importing a property that no longer existed.

Flint now remembers what each page object exposes, in
`.flint/page-objects.json`: per Screen Model page id, the contributing feature
ids, the element ids exposed as locators, and the actions that became methods.
`emitFeature` folds that record back into the current run's usage before
building, so a page object accumulates the union of what every feature needs.

Three properties worth stating, because they are what makes it safe:

- **Element ids, not code.** The Screen Model stays the single source of truth
  for roles, names and selectors. Parsing the emitted `.ts` file was the
  alternative and is rejected: a page object a human had edited would feed those
  edits back into generation, blurring the managed/hand-edited distinction the
  whole writer depends on.
- **A remembered element that is gone from the Screen Model is dropped, not
  resurrected.** A page object must not outlive the UI it addresses. The spec
  that used it then fails to compile — loudly, at the gate, before anything is
  written.
- **The merge is order-independent and idempotent.** Everything is a sorted
  union, so generating `login` then `search` gives byte-identical output to
  `search` then `login`, and regenerating either changes nothing.

The record is written only after the files land, so a failed run cannot leave it
claiming locators that were never emitted.

### Phase 4 status

Done: dialect interface + `playwright-pom`, POM emitter, spec emitter,
page-object reuse, `tsc --noEmit` gate before writing, idempotent writer with
hand-edit protection, `flint generate [--dry-run] [--no-gate]`.

Not done, and not claimed:

| Item                                                                               | Note                                                                                                                                                                   |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fixture emitter (auth storageState fixture, data-factory stubs from prerequisites) | `flint init` scaffolds `e2e/fixtures/auth.fixture.ts` as a pass-through; generated specs do not use it yet. Prerequisites currently become comments on a skipped test. |
| eslint gate                                                                        | The master plan asks for `tsc --noEmit` **and** eslint. Only the typecheck runs. Linting generated code needs the user's own eslint config, which may not exist.       |
| Extending an existing hand-written page object found in the Suite Index            | Reuse works across Flint-generated page objects. A pre-existing hand-written `LoginPage` is not detected or extended — Flint writes its own class beside it.           |
| ≥70% first-run pass rate on a demo app                                             | Requires a live `npx playwright test` run against saucedemo, which this environment cannot reach. Operator-verifiable only.                                            |

### Emitter fixes from the first live `flint generate` (operator log, 2026-08-12)

The run itself was clean — explore captured 4 pages / 55 elements with 55/55
verified selectors, the plan came back with the Login control correctly typed as
a button (the input-role fix landing), `generatedAt` read the real time, and
`generate --dry-run` and `generate` agreed. Reproducing the emitter's exact
input found four defects in the emitted code.

1. **A blocked case silently discarded its steps.** The plan gave
   `invalid-password-shows-named-error-message` four steps against real,
   verified element ids; it is blocked on one missing error element. The emitter
   wrote `test.fixme()` containing only the reason, so whoever unblocks it would
   start from scratch. The steps are now preserved as commented-out code,
   rendered exactly as the live version would be — unblocking is uncommenting.

2. **`@needs-setup` was missing.** The LOCKED TestPlan schema's emitter rule
   says a case with prerequisites becomes `test.skip()` "with a `@needs-setup`
   tag". It was not implemented, and the tag is the only handle on a test that
   is correct but waiting on a fixture — without it there is no way to run
   "everything that should pass today" (`--grep-invert @needs-setup`).

3. **`page.goto()` where `pageObject.goto()` belonged.** The crawler records the
   URL the browser reported (`https://www.saucedemo.com`, no trailing slash);
   the plan carries the canonical form (`…/`). The exact string compare missed,
   so the test repeated a URL literal the page object already owned. Both sides
   are now compared as `new URL(...).href`.

4. **A duplicated comment.** Each prerequisite was rendered once as a note and
   again as the skip reason.

None of these would have failed the compile gate — they are all correct
TypeScript. That is the argument for asserting emitted text directly in the
unit tests rather than settling for "it compiled".

### `<select>` naming, and a silent extraction failure under bundlers (2026-08-12)

The generated suite contained:

```ts
await expect(inventoryHtmlPage.nameAToZNameZToAPriceLowToHighPriceHighToLowSelect).toBeVisible();
```

**Fixed 1 — content that is data, not a label.** A `<select>`'s `textContent`
is the concatenation of its `<option>`s and a `<textarea>`'s is its current
value. Neither is an accessible name. Treating them as one produced that
identifier _and_ a `combobox[name="…"]` selector that can never match, wasting a
candidate slot on every select in the app. The accessible-name chain now stops
before `text` for those two tags.

The broader ARIA rule — only roles that support "name from content" (button,
link, heading, option, tab…) may take their name from text — is the fully
correct version. It is deliberately not implemented: it would also strip the
name from `[data-testid]` container divs, where the text currently is a useful
label and the behaviour works. Recorded per CLAUDE.md rule 7 rather than done.

**Fixed 2 — identifier length is now bounded.** A locator property takes at most
the first 5 words of a name. The selector still uses the full name, and
`uniquify` resolves any collision the trim creates.

**Fixed 3 — a better fallback when there is no name.** The emitter passes
`testId ?? domId ?? elementId`, so the saucedemo control reads as
`productSortContainerSelect` rather than `el1a2b3c4dSelect`.

**Fixed 4 — the serious one: `flint explore` captured nothing under `tsx`.**
Found while reproducing the above. Functions passed to `locator.evaluate` are
serialised with `Function.prototype.toString()` and re-parsed inside the page.
esbuild's `keepNames` — on by default in `tsx`, which is exactly what this
repo's own `pnpm cli` script uses — rewrites

```
const cssPath = () => { … }        ->  const cssPath = __name(() => { … }, 'cssPath')
```

and `__name` does not exist in the browser. Every element read threw a
`ReferenceError`, the surrounding `.catch()` swallowed it, and the crawl
reported **zero elements on every page** as though the application were empty.
It reproduced under `pnpm cli` and not under the compiled binary or vitest,
which is the worst possible split — the operator's runs were fine while the dev
entry point was quietly broken.

Three things changed:

- `readFacts`'s callback now declares no named function binding; the two helpers
  are inlined.
- `extractFrame` warns when it found candidate elements but could not read a
  single one. Skipping the odd detached node is normal; skipping all of them
  means the in-page read is broken, and silence turns "wrong" into "empty".
- `src/explorer/evaluated-callbacks.test.ts` guards the invariant across every
  file that evaluates code in the page, with a self-check proving the guard is
  not vacuous. (It earned its keep immediately: it caught its own too-loose
  regex, and then caught the explanatory comment describing the bad pattern.)

### Re-planning a feature deleted its own tests (operator log, 2026-08-12)

The most damaging bug found so far, and it only appears on the _second_ pass
through the pipeline:

```
flint plan login      -> 3 new cases + 2 blocked
flint generate login  -> writes login.spec.ts with those 3 tests
flint plan login      -> all 3 come back `skipped-duplicate`
flint generate login  -> rewrites login.spec.ts with ONLY the 2 blocked
                         fixmes. The 3 working tests are gone.
```

The spec file is managed, so the writer replaced it without complaint. Nothing
warned, and the operator's log shows exactly this: `skipped-duplicate 3`,
`Tests: 2`, `update e2e/tests/login.spec.ts`.

The planner was not wrong about the facts — those titles really were in the
suite. It was wrong about what they meant. A test Flint generated for feature X
is not prior art that a re-plan of X should defer to; it is the previous answer
to the question being asked, and the new plan supersedes it.

`supersedeOwnGeneratedTests` now removes, from the coverage map handed to the
planner, the titles that live in **managed** spec files. Three properties make
that safe:

- Only managed files are hidden. A managed file is one Flint wrote and nobody
  has touched since, so regenerating it loses nothing.
- The moment a human edits it, it is `hand-edited` and its tests count as
  coverage again — the planner defers to them. Conservative direction: at worst
  a case is skipped that a human can un-skip.
- Hand-written tests carrying the same feature tag are always kept. Those are
  genuine prior art, and not duplicating them is the whole point of the index.

Note this is the _third_ variant of the same underlying mistake — "Flint treats
its own previous output as somebody else's work". The other two were
`planHistoryCoverage` (a stored plan deduping against itself) and the page-object
overwrite (a second feature dropping the first's locators). Worth watching for a
fourth in Phase 5: a repair loop must not treat its own last attempt as the
user's code.

### The compile gate had never actually run (2026-08-12)

Helping the operator get `npm install` working in their suite exposed two
defects that made Phase 4's headline guarantee vacuous.

**1. `flint init` scaffolded no `package.json` for the suite.** It wrote
`playwright.config.ts`, `tsconfig.json` and the directory skeleton, but no
manifest — so `npm install` inside `e2e/` had nothing to install and
`npx playwright test` could never work. `@playwright/test` is a dependency of
the _generated suite_, not of Flint, and nothing said so. The template now
carries a manifest with `@playwright/test`, `@types/node` and `typescript`,
plus scripts including `test:ready` (`--grep-invert @needs-setup`, which is what
the tag is for). `flint init`'s next-steps now name the install explicitly.

`@types/node` matters more than it looks: the scaffolded tsconfig declares
`types: ["node", "@playwright/test"]`, so without it every run produced TS2688
and the gate excused itself as "dependencies not installed".

**2. The gate's scratch directory was in the wrong place.** It was written to
`<projectRoot>/.flint/gate/`, and `moduleResolution` walks _up_ from the
tsconfig looking for `node_modules`. The suite's dependencies live at
`<suiteRoot>/node_modules`, which is not on that path — so even a correctly
installed suite produced nothing but missing-module errors, `isEnvironmentOnly`
classified them as environmental, and the gate skipped. **It had therefore never
run against a real project.** The earlier operator logs saying "the suite's own
dependencies are not installed" were half right for the wrong reason.

The scratch now lives at `<suiteRoot>/.flint-gate`, removed in a `finally`, and
`discoverSuiteFiles` ignores it so a copy cannot nest inside a copy.

Verified end to end against a genuinely installed suite: `flint generate login`
now prints "Typechecked clean before writing", the gate rejects
`Property 'nope' does not exist on type 'Page'`, and `npx playwright test --list`
discovers and compiles the generated spec. A regression test installs a fake
package under `<suiteRoot>/node_modules` and asserts the gate resolves it, so
the gate cannot silently go dormant again.

Worth stating plainly: every earlier claim that "the gate passes" was really
"the gate skipped". The `ran` flag existed precisely so a skip could not be
mistaken for a pass, and it is what made this findable.

### First green test, and the fourth self-input bug (operator log, 2026-08-12)

A Flint-generated test passed against the live application for the first time:

```
✓ 4 …login.spec.ts:8:7 › Sign in to Swag Labs › User opening the site root
    sees the sign-in form … (692ms)
  3 skipped, 1 passed (1.3s)
```

`generate` also printed **"Typechecked clean before writing"** — the compile
gate running for real against an installed suite, which had never happened
before. Phase 4's pass-rate criterion is now measurable: of the tests that were
runnable at all, 1 of 1 passed.

**Fixed — tags doubled in test titles, compounding each round.** The suite showed

```
… lands on the products page @flint @feature:login @feature:login @flint @needs-setup
```

Tags ride in the test title, because that is how Playwright greps them and how
the Phase 2 indexer reads them back. That closes a loop: the emitter appends
tags to the title → the indexer reads those titles → the planner sees the
convention and starts writing tags into `title` itself → the next emit appends
a second copy. Round three would have produced three.

`splitTitleTags` now pulls trailing `@tag` tokens back out of the title and
folds them into the tag set, so the transform is idempotent whatever the planner
writes. Only _trailing_ tokens are stripped, so a title containing `a@b.com`
keeps it. Fixing this emitter-side rather than by tightening the prompt is
deliberate: the emitter cannot control what a model writes, only what it emits.

This is the **fourth** instance of the same root mistake — Flint treating its own
previous output as somebody else's input. The others: `planHistoryCoverage`
deduping a plan against itself, the page-object overwrite dropping another
feature's locators, and a re-plan skipping its own generated tests. The prediction
in the previous entry was that a fourth would appear; it did, within a day. Any
value Flint writes that Flint later reads needs this question asked of it.

**Fixed — `flint init` quietly reset the operator's auth config.** They answered
`y` to the overwrite prompt, which replaced `flint.config.ts` with the template,
resetting `auth.mode` to `none`. The next `flint explore` then crawled the login
screen instead of the application (1 page, "login wall suspected") and the
`populated-cart` flow timed out for want of a session — a confusing failure two
commands away from its cause.

The prompt now marks which conflicts hold user settings (`flint.config.ts`,
`kb/**`), states plainly what overwriting them costs, and points at the "n"
answer that adds only missing files. The capability is unchanged; the
consequence is no longer hidden in a list of twelve paths.

### A suite where nothing runs (operator log, 2026-08-12, second run)

With auth restored the pipeline behaved: 4 pages, 55/55 verified selectors, the
flow replayed, tags appeared exactly once, and the gate printed "Typechecked
clean before writing". But the run went **from 1 passing test to 0** — all four
skipped. The regression was in the plan, not the code:

```
~ User opens the site root and sees the sign-in form
    needs setup: Base URL points at https://www.saucedemo.com/
```

The base URL is obviously configured — the crawl used it. The planner attached
a vacuous prerequisite, the LOCKED ladder turned that into `test.skip()`, and
the one test that had passed the round before stopped running.

The prompt caused it. It said "Use `prerequisites` for test data, **config
values**, external services, or manual setup", and a base URL is a config value.
Prompt v3 now states the _cost_ ("every prerequisite you add makes the test
SKIP … a prerequisite that is already satisfied silently deletes a working test
from the run"), gives a test for whether something qualifies (name the action a
human would take), and lists what never counts — the app being reachable, the
base URL, anything in `flint.config.ts`, and any credential the crawl already
signed in with.

The LOCKED ladder itself is unchanged. The rule was never wrong; the input was.

**Deterministic backstop.** Prompts drift, so `flint generate` no longer lets
this pass quietly: when every emitted test is degraded it prints
`WARNING: none of the N test(s) will run`, names how many are skipped only for
setup, and exits non-zero. A suite that proves nothing previously looked exactly
like success — files written, gate clean, green output.

Also corrected a warning that overstated its case: dropping a locator whose
element left the Screen Model said "specs using them will stop compiling", but
in the operator's run nothing referenced it and the typecheck passed. It now
says any spec _still referencing_ them will fail the gate.

### The element net never caught the things tests assert on (2026-08-12)

The operator added a flow script that drives saucedemo into its post-failed-
submit state. The flow ran, captured two states — and the plan still came back
with both error cases blocked, now down to **0 runnable tests**. The planner's
report was precise enough to diagnose from:

> only the Username textbox, the Password input, the Login button and **an
> unlabelled button** (gated on the "login-errors" flow) that appears to be the
> error dismiss control rather than the message itself

saucedemo's error markup is:

```html
<h3 data-test="error">Epic sadface: Username and password do not match…</h3>
<button class="error-button"></button>
```

The flow reached the state correctly. The extractor then captured the dismiss
_button_ — because `button` was in its net — and discarded the `<h3>` carrying
the message, which is the only thing AC3 actually needs.

**Two defects, both in `INTERACTIVE_SELECTOR`.**

1. _It only caught interactive elements._ Its own comment said "elements a test
   could plausibly interact with **or assert on**", and the second half was
   never implemented. An error banner is the most asserted-on element in any
   sign-in feature; a heading is how a test confirms which page it is on. The
   planner's earlier question "which on-page element identifies the products
   page" was the same gap wearing a different hat. Headings (`h1`–`h6`,
   `[role=heading]`), alerts, `[role=status]` and `[aria-live]` regions are now
   captured.

2. _It hardcoded `[data-testid]`._ The attribute is configurable everywhere else
   — the ranker emits `[${testIdAttribute}="…"]` — but the capture net ignored
   it. An app using `data-test` or `data-qa` therefore had **none** of its
   deliberately-marked elements captured: precisely the elements its authors
   flagged as mattering most, and the ones that score 100. It is now a parameter.

Verified against saucedemo's real markup: with the default attribute the error
`<h3>` is captured with its text (the fix that unblocks the operator today);
with `testIdAttribute: 'data-test'` the test ids come through as well, plus the
`<span data-test="title">Products</span>` that identifies the inventory page.

One existing test asserted that an `<h1>` was skipped. That premise is exactly
what changed, so the test was rewritten to state the new contract — a heading is
captured because tests assert on it, bare prose is not — rather than weakened to
keep passing.

**Still needed, and it is a schema change: `explorer.testIdAttribute`.** Nothing
in `FlintConfigSchema` lets a user say their app uses `data-test`, so fix (2) has
no way to be switched on from a project. CLAUDE.md rule 4 puts schema changes
behind explicit human approval, so this is recorded here rather than done.

## Phase 4 — exit criteria verified (2026-08-12)

The operator's run, against live saucedemo with no hand-editing:

```
✓ User visiting the site root sees the sign-in form            (710ms)
✓ User with valid credentials lands on the products page       (807ms)
✓ User with an invalid password sees an error that names …     (842ms)
✓ Locked-out user is refused with a lockout message            (814ms)

  4 passed (1.8s)
```

`degraded: 0`. Nothing blocked, nothing skipped, nothing invented.

| Master plan exit criterion                                  | Result                                                                             |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Generated suite compiles + lints clean 100%                 | "Typechecked clean before writing" on every run; the gate rejects real type errors |
| ≥70% first-run pass rate on demo apps                       | **100% (4/4)**                                                                     |
| Regenerating a feature is byte-identical                    | Writer reports `same` for untouched files; asserted in unit tests                  |
| No duplicate page objects across features touching one page | `.flint/page-objects.json` merges per page id; asserted in unit tests              |

Merged to `main` at `b1cfe26` — 28 commits, clean fast-forward from `b01520b`.

### What it took, and what that says

Four passing tests took eleven fixes found by running the thing. The pattern
worth carrying into Phase 5:

- **Four separate bugs were one mistake.** Flint reading its own output as
  somebody else's input: a plan deduping against itself, a page object dropping
  another feature's locators, a re-plan skipping its own tests, and tags doubling
  in titles. Any value Flint writes and later reads needs that question asked.
  In Phase 5 the candidate is a repair loop treating its own last attempt as the
  user's code.
- **The gate had never run.** It reported "dependencies not installed" for weeks
  because its scratch copy sat where `node_modules` could not resolve. The `ran`
  flag — added so a skip could not be mistaken for a pass — is the only reason
  it was findable. Phase 5's verifier needs the same distinction between "the
  check says no" and "the check did not happen".
- **The planner's questions were bug reports.** "An unnamed textbox … is this
  the Login button?" found the input-role mapping. "An unlabelled button that
  appears to be the error dismiss control" found the element net missing every
  assertion target. Grounding produced diagnostics, not just refusals.
- **Two tests were deleted silently before anything caught it.** Both times the
  output looked like success. The CLI now refuses to be quiet: it warns when no
  test will run and exits non-zero.

### Carried into Phase 5

| Item                                           | Note                                                                                                                                     |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Fixture emitter                                | Auth storageState fixture and data-factory stubs. Not built; prerequisites become comments on a skipped test.                            |
| eslint gate                                    | Plan asks for `tsc` **and** eslint; only the typecheck runs. Needs the user's own config.                                                |
| Extend a pre-existing hand-written page object | Reuse works across Flint-generated ones only.                                                                                            |
| `explorer.testIdAttribute`                     | **Resolved 2026-08-13** — approved and shipped. See "The `explorer.testIdAttribute` key" below.                                          |
| iframe-hosted elements                         | Degrade to `test.fixme`; the frame's own selector was never verified.                                                                    |

## Phase 5 — Verifier (in progress)

### Built so far

`classifier.ts`, `playwright-report.ts`, `health.ts`, `runner.ts`, `report.ts`
and `flint verify`. Everything except the repair loop, which is next.

The design follows one rule taken directly from Phase 4's most expensive bug:
**a check that did not happen must never read as a check that passed.** The
compile gate silently skipped for weeks because a skip looked like a pass, and
only the `ran` flag made it findable. Three places carry that idea now:

- `runSuite` returns `ran: false` with a reason. An empty test list from a run
  that never started is not a green suite, and `requireRan` exists so a caller
  cannot forget.
- `passRate` returns `undefined` — not 0, not 100 — when nothing ran, and its
  denominator counts only tests that executed. Including skips would let a
  suite reach "100%" by running nothing at all.
- `flint verify` exits non-zero when nothing ran, when the app was unreachable,
  or when anything failed.

### Two judgements worth recording

**An unhealthy environment reclassifies every failure as `env`.** If the app
was unreachable before the run, no failure in that run says anything about the
tests. Leaving them as `selector-not-found` would hand the repair loop a suite
of correct tests to "fix" against a machine that was simply off — the exit
criterion says env failures are "never repaired", and this is what enforces it.
The original error text is preserved under a `[reclassified: …]` prefix so
nothing is lost.

**Any HTTP answer counts as healthy, including a 500.** A 500 is the
application failing, which is precisely what a test should catch. Calling it an
environment failure would suppress a real finding. Only transport failures —
refused, DNS, TLS, timeout — mean there is nothing to test against.

### Classifier ordering, which is load-bearing

Two orderings are asserted because getting them wrong is silent and expensive:

- **env before navigation.** `net::ERR_CONNECTION_REFUSED` arrives _as_ a
  `page.goto` failure while meaning the server is down. Classified as
  navigation, it would enter the repair loop.
- **selector-not-found before timeout.** Both patterns appear in the same
  message (`Timeout 30000ms exceeded … waiting for locator(…)`). Called a
  timeout, it would skip the free deterministic retry with the next verified
  candidate.

Every pattern in the table is a shape Playwright actually emits. A classifier
tested against invented error text looks thorough and matches nothing, which
would route every real failure to `unknown` — where, by policy, repair refuses
to act.

### Verified end to end

`flint verify` against the Phase 4 suite in this sandbox: the run happened, the
JSON was parsed, the missing browser binary was classified `env` rather than
blamed on the test, the report was written to `.flint/reports/<runId>.json`, and
the command exited 1. Full chain — spawn, parse, classify, assemble, write —
exercised against real Playwright output rather than a fixture.

### The repair loop

Built: the deterministic selector retry, the caps, the fixme history block, and
`flint verify --repair`. The LLM repair path is not built — the loop says so
explicitly rather than pretending it tried something.

**Ordering, as the master plan requires.** A `selector-not-found` failure
retries with the next verified candidate from the Screen Model _before_ any
model is consulted. That attempt is free, instant, and cannot invent a selector:
the replacement was confirmed against the live page during exploration, exactly
like the one it replaces. Spending a model call first would be slower, costlier
and strictly less trustworthy.

**Two independent brakes.** `MAX_REPAIR_ITERATIONS = 2` (LOCKED) and a
per-test wall-clock budget, both enforced inside `repairTest` rather than
trusted to the caller. A repair loop missing either is how a tool spends an
afternoon and a fortune rewriting a suite nobody asked it to touch, and it is
invisible until it happens. Both are tested by asserting the loop _stops_.

**What it refuses, and why that is the feature.** `env` failures — patching a
test cannot start a stopped server. `unknown` failures — a blind edit to code
that might be correct is precisely how a repair loop corrupts a suite. A page
object whose contents do not match what the Emitter wrote — refusing hands the
case to a human with the file intact rather than guessing at it. Each refusal
carries its reason into the report.

**An assertion mismatch that survives repair is promoted, not buried.** It is
marked `possibleAppDefect` and the fixme block says plainly: check the
application before changing the test. Flint finding a real bug is the point.

**The recurring bug, and how this loop avoids it.** Four times in Phase 4 Flint
read its own previous output as somebody else's input. The equivalent here would
be the loop mistaking its own last patch for the user's code. Three things
prevent it: every selector tried is remembered and never re-proposed; the
"previous" expression is taken as the _most recently written_ one rather than
the first in ranked order; and a patch is kept only when a re-run actually
passes.

That middle point was a real bug, caught by a test rather than by inspection.
Taking the first-in-ranked-order candidate meant the second iteration tried to
replace an expression the first iteration had already replaced — the swap
silently failed to match and the loop gave up one attempt early, looking for all
the world like "no other selector available".

**A re-run that cannot be scoped returns the test unchanged**, which the loop
reads as still-failing. Claiming a repair worked when the test was never
actually re-run would be the worst available outcome, so the failure direction
is deliberate.

### Phase 5: what is built, and the one gap

Built and tested: failure classifier, Playwright JSON report parser, environment
health check, suite runner, run-report assembly and writer, deterministic
selector retry, the repair caps, the fixme history block, and
`flint verify [--feature] [--ready] [--repair] [--no-health-check]`.

Not built: the LLM repair path. When no deterministic repair applies, the loop
records `no deterministic repair applies to a <class> failure` and stops. That
is an honest gap, not a silent one — the report says what was not attempted.

Not yet verified: the Phase 5 exit criterion of a ≥90% post-repair pass rate.
That needs a live `flint verify --repair` run against a real suite, which this
sandbox cannot do (no browser binary, and the demo app is reached over the
network). It is a run to make locally, not code to write.

## The `explorer.testIdAttribute` key (schema change, approved 2026-08-13)

The second post-Phase-0 schema change, and like the first (`Element.provenance`)
it went through explicit human approval per CLAUDE.md rule 4.

**The bug it fixes was one of wiring, not logic.** `buildCandidates` and the
element capture net had always accepted a `testIdAttribute` option
(`selector-ranker.ts:66`, `extractor.ts:104`). Nothing ever passed one. The
crawler had the whole `FlintConfig` in hand and did not forward it, and
`FlintConfigSchema` had no key to forward. So `'data-testid'` — a library-level
fallback default — was the only value any real run has ever used.

On an app that marks its hooks `data-test` (saucedemo, and plenty of others)
`facts.testId` was therefore always `undefined`, the `testid` candidate was never
built, and every selector silently degraded to role, label or CSS. That is
precisely the fragility the LOCKED ranking exists to prevent: a role selector
breaks when someone renames a button, a `data-test` attribute does not. The
Phase 4 suite passing 4/4 was passing on second-choice selectors.

```ts
testIdAttribute: z.string()
  .min(1, 'explorer.testIdAttribute cannot be empty (e.g. "data-testid" or "data-test")')
  .default('data-testid'),
```

**Additive and defaulted to the previously hardcoded value**, so no config that
predates it changes behaviour. Threaded at three call sites — the crawler's
`extractPage`, the interaction pass, and `flows.ts`. That third one matters:
`elementId()` hashes the test id, so a flow capturing the same element with a
different attribute than the crawl would mint two ids for one element.

**Known consequence, accepted at approval time.** Setting this to a new value
changes `elementId` for every element carrying that attribute. The first
`flint explore` after the change reports the whole app as drifted under `--diff`,
and an existing TestPlan's `elementId` references go stale — the referential
validator will reject it, which is the correct behaviour rather than a
regression. Re-run `flint plan` and `flint generate` once after changing it.

**No coupling to Playwright's own `testIdAttribute`.** The dialect emits
`this.page.locator('[data-test="x"]')`, a plain CSS attribute selector, not
`getByTestId` (`playwright-pom.ts:54`). The scaffolded `playwright.config.ts`
needs no matching setting.

### Tested through `crawl`, not through the extractor

Two new tests in `crawler.test.ts` go through the full `crawl` entry point,
because an extractor-level test could never have caught this: the extractor was
correct the whole time. One asserts the configured attribute produces a
score-100 `testid` candidate ranked first; the other pins the degraded
behaviour, so a future regression reads as "fell back to a weaker selector"
rather than passing silently. The fixture page is unlinked and reached by
`startUrl`, so it does not shift the page counts the BFS and budget tests
assert on.

### Sandbox note: the browser-backed tests can run here after all

`FLINT_BROWSER_EXECUTABLE=/opt/pw-browsers/chromium` launches the
pre-installed Chromium (revision 1194) even though Playwright 1.62.1 wants
1234. All 24 pre-existing `crawler.test.ts` cases pass under it. Previous runs
that reported these as skipped were skipping for lack of a browser, not by
design — worth knowing, since a skipped test that reads as a pass is the exact
failure mode Phase 5 was built to avoid.

### The LLM repair path

The last Phase 5 component. It runs **only** after the deterministic selector
retry has been tried and produced nothing, and what it proposes is checked in
code before a byte is written.

**Why this module is mostly validation.** A repair loop with a model in it is
the most dangerous component in Flint, because its failure mode is a *passing
test*. Everything else in the pipeline fails loudly when it is wrong. This one
can quietly delete the thing a test was checking and report success — and a
green suite is the one thing nobody investigates. The prompt asks the model to
behave; `llm-repair.ts` enforces it. Only the second is load-bearing, and the
tests exercise the enforcement, not the asking.

Four rules, each with a test that feeds the module a proposal breaking it:

1. **No invented selectors.** Every locator an edit introduces must be one the
   explorer verified against the live page. A model-authored selector that was
   never verified either matches nothing or — far worse — matches the wrong
   element and passes. `verifiedExpressions()` renders the allowed set from the
   Screen Model with both roots (`this.page.` and `page.`), because a locator
   legitimately moves between a page object and a spec.
2. **No weakened assertions.** Rewriting `expect('Welcome')` to
   `expect('Error')` because the app produced "Error" makes the test pass and
   destroys its only purpose — and that is precisely the case where the
   application may genuinely be broken. Detected structurally: the received
   value from Playwright's error appearing in the replacement but not the
   original. That catches it however the edit is phrased.
3. **No skipping.** `test.skip`, `test.fixme`, `test.only`, an empty `catch`,
   or a net loss of `expect(` calls. All "make the red go away" moves. Flint
   decides when to give up; the model does not.
4. **Exact-match edits only.** Single-occurrence string replacements. An edit
   whose `find` is absent is rejected (the file is not what we think it is); one
   that matches twice is rejected (where it meant is ambiguous). A repair cannot
   rewrite a file wholesale under cover of a fix.

Rejection is all-or-nothing across the proposal. A partially applied repair
leaves a file in a state neither Flint nor the model intended, which is strictly
worse than the failing test we started with.

**Failed model patches are reverted; failed selector swaps are not.** The two
paths are cleaned up differently on purpose. A selector-retry swap put a
*verified* selector in the file — the same class of thing the Emitter writes —
and the next `flint generate` restores the canonical form. A model patch is
arbitrary model-authored code, and leaving it behind in a suite that is *still
failing* is worse than the failure. The snapshot that makes the revert possible
is taken from the files as they stand at that iteration, so reverting undoes
that patch and not the whole loop.

**A provider failure is not a repair outcome.** `StructuredOutputError` — the
model could not produce the right shape after the provider's own retries — is
reported as "no usable proposal" and the loop moves on. An expired key or a rate
limit is *not*: reporting that as "the model had no repair to offer" would hide
the real problem behind a plausible one. It propagates, and `repairFailures`
catches it per test so one broken repair cannot throw away the run report for
every test that already ran.

**Two facts kept distinct.** "No deterministic repair applies to a `timeout`
failure" and "the selector retry ran out of candidates" are different things,
and the report says which. Collapsing them would mislead whoever reads it.

**Caps unchanged.** `MAX_REPAIR_ITERATIONS = 2` and the wall-clock budget cover
model iterations exactly as they cover deterministic ones — the model does not
get its own allowance.

### CLI

`flint verify --repair` now consults a model when one is available.
`--no-llm` forces deterministic-only. A missing `ANTHROPIC_API_KEY` does **not**
fail the command: the selector retry is the more valuable half and needs no
model, so it degrades and says so.

### A test-fake bug this caught

The first version of the revert test failed, and the fake was at fault rather
than the code. `deps().rerun` returned a fixed `failing()` whose class is
`selector-not-found`, so a `timeout` test came back from its re-run reclassified
— and iteration 2 silently switched onto the deterministic path. The fake now
preserves the failure class the test still has, which is what a real re-run
reports.

## Phase 5 completed (2026-08-13)

Three gaps remained against the master plan's Phase 5 build list. All three were
things that looked done and were not.

### The fixme fallback was generated but never written

`repairHistoryComment()` had existed since 5.4 and produced a good comment
block. Nothing ever put it in a file. A test repair could not fix stayed exactly
as it was, and the only record was a JSON report a user may never open.

`fixme.ts` now converts `test('title', …)` to `test.fixme('title', …)` with the
block above it, and `repairFailures` calls it for every test repair gave up on.

**Idempotence is the requirement, not a nicety.** Run it twice and a naive
version stacks comment blocks and rewrites `test.fixme` into
`test.fixme.fixme`, compounding on every verify until the file no longer parses
— silent for several runs, then baffling. The same shape as the bug that
appeared four times in Phase 4. So the block carries `@flint:repair-failed` and
a marked test is left alone.

The idempotence check looks only at the comment block *immediately preceding*
the call, not the whole file. Checking the whole file would refuse to mark a
second failing test in a file that already had one marked — a test that then
silently loses its explanation. That case has its own test.

**Matching is exact-title.** `test('signs in')` must not be hit when marking
`test('signs in with valid credentials')`, or repair disables the wrong test.
Also tested: `test.describe('works')` is not mistaken for `test('works')`.

**The marker does not change this run's report.** Re-badging the result `fixme`
would drop the test out of the pass-rate denominator, and a suite could reach
100% by giving up on everything. What happened in this run is that the test
failed. The marker is what happens to the *next* run.

### Nothing established a test was broken before patching it

The scaffolded Playwright config is `fullyParallel: true` with `retries: 0`
outside CI, so Playwright's own flaky detection never fires on a local run.
Nothing distinguished "this test is wrong" from "this test was disturbed by
another test running beside it" — and those need opposite responses. Patching
the second kind corrupts a test that was correct.

Every failing test is now re-run **on its own, unchanged**, before repair is
considered. Pass-on-retry without a code change is `flaky` by the master plan's
own definition, and flaky tests are not repaired. That satisfies the flaky
detection exit criterion in a way that does not depend on retries being enabled.

The cost is one scoped Playwright run per failing test — cheap next to a model
call, and far cheaper than a suite repaired into agreeing with whatever happened
to run first.

`rerunScoped` returns `undefined` when the run did not happen or the title
matched nothing, and `isolationVerdict` maps that to `inconclusive`, on which
repair proceeds. "We could not find out" must never collapse into "it is fine".

**The collision advice names both causes.** Shared state is the common one
(remedies: `--workers=1` to confirm, then unique factory data or
`test.describe.serial`). Session expiry mid-run produces the identical signature
— everything after a point fails, each passes alone — and would be misdiagnosed
by shared-state advice alone, so the report names it and says to check whether
the failures cluster at the end of the run. That is the master plan's
"auth expiry mid-run" scenario, handled as a diagnosis rather than an automatic
recovery.

### The suite did not receive the configured base URL

`runSuite` accepted an `env` option that the CLI never passed. The scaffolded
`playwright.config.ts` reads `process.env.BASE_URL ?? '<baked-in default>'`, so
a changed `flint.config.ts` was ignored until the suite was regenerated.
`flint verify` now passes `BASE_URL` from config.

### Phase 5 build list, verified against the master plan

| Item | State |
| --- | --- |
| Runner, scoped, env from config | done |
| Failure classifier, trace/screenshot paths attached | done (`artifacts`, populated by the report parser) |
| Repair loop, max 2 LOCKED, selector retry before any LLM call | done |
| Fixme fallback with comment block | done (this section) |
| RunReport writer | done |
| `flint verify [--repair]` | done, plus `--feature`, `--ready`, `--no-llm`, `--no-health-check` |
| Env failures detected pre-run, never "repaired" | done |
| Zero infinite loops (iteration cap + wall clock) | done |
| Flaky detection, not repaired | done (this section) |
| Assertion mismatch surviving repair → possible app defect | done |
| Data collisions → serial mode / factory uniqueness advice | done (this section) |
| Auth expiry mid-run | diagnosed, not auto-recovered |
| Post-repair pass rate ≥90% on golden set | **needs a live run** |

The one remaining item is a measurement, not code. It needs a machine with a
browser and network reach to the demo app.

### The two-directory problem (found in the operator's first Phase 5 run)

The testing guide assumed the Flint checkout and the project under test were the
same directory. They are not: the tool lives in `~/…/Flint`, the demo project in
`~/flint-demo`. `pnpm cli` is a script in Flint's own `package.json`, so running
it from the demo project falls through to the registry and dies on the
operator's `~/.npmrc`:

```
[ERROR] Failed to decode _auth as base64
```

Nothing to do with Flint, and nothing to do with npm credentials — the wrong
working directory, reported by a tool three layers away from the cause. The
guide now sets `DEMO` once and passes `--dir "$DEMO"` on every command, which
was always supported and never documented.

**The error message that should have caught it.** Running any command from
Flint's own checkout produces `No flint config found`, and the hint said only
"Create a flint.config.ts (run `flint init`)". That sends someone off to
scaffold a second project they did not want, which is worse than saying nothing.
It now offers `--dir <path>` first, because pointing at an existing project is
the likelier intent. Tested, so it cannot quietly regress to the unhelpful form.

### Two more guide defects, and a stale-suite trap worth naming

**`plan` and `generate` take a feature id.** The guide ran them bare, which
produces `No feature id given` with a list of what is available. The command is
right; the guide was wrong. They are per-feature by design — `flint ci`, the
chained pipeline, is Phase 6 and still a stub, so there is deliberately no
"do them all" form yet. The guide now loops over the feature ids explicitly,
with `|| break` so a failed `plan` does not march on into `generate`.

**A stale suite passes and looks like success.** In the operator's run,
`explore` and `index` succeeded, `plan` and `generate` both errored out, and
`verify` then reported 4/4 and 100%. All true — and all measuring the suite as
it was generated *before* `testIdAttribute: 'data-test'` was set. Nothing was
wrong, and nothing was learned either.

`verify` runs whatever is on disk and has no way to know the generated code
predates the current Screen Model. `generate` does warn when a plan's
`screenModelVersion` differs from the model's, but that fires at generate time,
which is exactly the step that did not run.

Closing that properly is Phase 6's drift mode (`explore --diff` → which tests
are affected), so this is not something to build now. The guide instead gives a
one-line check with a definite answer:

```
grep -c 'data-test' "$DEMO"/e2e/pages/*.ts
```

Zero means `generate` never ran against the new model, and every number below it
is about the old suite.

This is the third guide defect in three runs — two-directory conflation, then
the missing feature argument, now the unverified regeneration. Each time the
tool behaved correctly and the instructions did not. Worth recording as a
pattern: the CLI's error messages have been carrying the guide.

### Hints that are runnable, not merely correct

`No feature id given` was hit four times across three sessions. The message was
accurate — it stated the grammar and listed the available features — and it
still did not get the operator to the right command, because reconstructing
`flint plan cart --dir /Users/…/flint-demo` from `Usage: flint plan <feature>`
is work.

Both `plan` and `generate` now append a runnable line:

```
hint: Usage: flint plan <feature>. Available: cart, example-login, login
      Try: flint plan cart --dir /Users/…/flint-demo
```

`dirSuffix` (`src/cli/hints.ts`) echoes the caller's own `--dir` and says
nothing when the default is in use. Echoing it is the point: these commands are
usually run from a different directory than the project they target, so a
suggested command without `--dir` would be wrong in exactly the case where the
hint is most needed.

Four repetitions of the same mistake is a signal about the message, not about
the person reading it.

### The 4096-token output ceiling (found on the first live `flint plan`)

`flint plan cart` failed with `stopReason: max_tokens` at 4096 output tokens.
`DEFAULT_MAX_TOKENS = 4096` was set in Phase 0 and never revisited, and no
caller ever overrode it — so every LLM call Flint has ever made was capped
there.

Two things make 4096 worse than it looks on current models: **adaptive thinking
is on by default**, and `max_tokens` caps thinking *plus* response text
together. A budget sized around the expected JSON leaves nothing for the
reasoning that produces it. A TestPlan with several cases, each with steps and
assertions, does not fit.

Raised to 16k — the largest value that is safe on a non-streaming request.
Above roughly that, the SDK risks an HTTP timeout rather than a clean answer.
The models themselves go to 128k, which would need `messages.stream()`; that is
a real option if plans ever outgrow 16k, and a bigger constant is not.

**The error message named the wrong config key.** It said "Raise maxTokens for
this call (see tokenBudgets in flint.config.ts)" — but `tokenBudgets` is the
*prompt* budget and has no effect on the output ceiling. There is no config key
that controls this. Naming the wrong one is worse than naming none: it sends
someone to change a setting that cannot fix what they are looking at. The hint
now says plainly that this is an output ceiling, that `tokenBudgets` will not
change it, and that thinking shares the budget.

No schema change was made. A per-stage output budget would be a reasonable
config key, but it needs approval under rule 4 and the deterministic fix
unblocks the operator now.

### Stale page objects across features (the `testIdAttribute` aftershock)

`flint generate cart` failed the compile gate on five errors, **all in
`tests/login.spec.ts`** — a file that run never touched:

```
tests/login.spec.ts(30,36): error TS2339: Property 'elCf510ff0b994Select' does not
  exist on type 'InventoryHtmlPage'.
error: The generated suite failed the compile gate.
hint: This is a Flint bug — please report the feature id and the errors above.
```

**The gate was right and the message was wrong.** Setting
`testIdAttribute: 'data-test'` changed every element id (they hash the test id).
`login` had been generated against the *old* ids, and its records in
`.flint/page-objects.json` still named them. Generating `cart` re-emits the
shared page objects, drops stored locators whose elements are no longer in the
model — and `login.spec.ts`, untouched on disk, is left referencing properties
that no longer exist.

This is the fifth appearance of the recurring bug class: **Flint reading its own
previous output as somebody else's input.** The page-object store is Flint's own
record from an earlier run, and nothing checked whether it still matched the
current model.

**Flint already knew the answer and threw it away.** `seedFromRecords` logged
`dropped locators whose elements are no longer in the Screen Model; any spec
still referencing them will fail the compile gate` — an exactly correct
prediction, at `warn` level, seconds before the gate proved it — and then the CLI
called the result a bug and asked for a report. The stored record even carries
`features`, so the owning feature was in hand the whole time.

`EmitResult` now carries `staleLocators` (class name, dropped element ids, and
the features that own them, excluding the one being regenerated — it is
rewriting its own spec, so it is not the one left dangling). When the gate fails
and that list is non-empty, `flint generate` says what actually happened and
prints the exact commands, in order:

```
This is a stale-suite failure, not a defect in the generated code.
  InventoryHtmlPage: 3 locator(s) dropped
The errors above are in login — feature(s) this run did not regenerate.
Re-plan and re-generate them first, then this one:

  flint plan login --dir /Users/…/flint-demo
  flint generate login --dir /Users/…/flint-demo
  flint generate cart --dir /Users/…/flint-demo
```

Re-planning is part of the remedy, not optional: the stale feature's *plan*
references the old element ids too, so regenerating without re-planning would
fail the referential validator instead.

**Ordering is why the operator's loop failed.** `for f in cart example-login
login` is alphabetical, and `cart` came first — merging `login`'s stale records
before `login` had a chance to be rebuilt. Had `login` run first, its spec and
records would have been rewritten together and the run would have converged. A
one-shot `flint ci` that orders this correctly is Phase 6; until then the
message tells the operator the order.

**Not fixed, deliberately:** the emitter still drops the stale locators rather
than keeping them. A page object must not outlive the UI it addresses, and
keeping a locator for an element the explorer can no longer find would trade a
loud compile error for a silent runtime failure. The gate blocking the write is
the correct outcome — the defect was only ever the explanation.

### The exemplar re-introduced what superseding hid (sixth instance)

The run that looked like a clean success destroyed a feature's tests.

```
plan login   → superseded: 4 … Cases: 4, skipped-duplicate 4
generate login → Tests: 0, update e2e/tests/login.spec.ts, Wrote 1 file(s)
index        → Spec files: 2 (13 tests), Features covered: 2
```

Before the run: 1 spec file, 4 tests, `login` covered. After: `login` is gone
and 13 tests remain (example-login 5 + cart 8). The four working login tests
were overwritten with an empty file, and every line of output read as success.

**How it got past the fix that exists for exactly this.**
`supersedeOwnGeneratedTests` did its job — `superseded: 4` is in the log, and
the titles were removed from the coverage map. But it only edits the
**coverage map**. `readExemplars` then took the first two entries of
`index.specs`, read `tests/login.spec.ts` **off disk in full**, and put it in
the prompt as a house-style sample. The model saw four login tests sitting in
the exemplar and marked its own four cases `skipped-duplicate`.
`forcedDuplicates: 0` confirms the deterministic post-check did not do this —
the model did, from evidence Flint handed it after deciding to hide that very
evidence.

Sixth appearance of the recurring class, and the second time in the same place:
Phase 4 fixed the coverage-map door, and the same output walked back in through
the exemplar door.

**Two fixes, at different depths.**

`ownedSpecFiles(index, featureId)` names the managed spec files whose titles
this feature's coverage map claims — computed *before* superseding, since
superseding is what removes the titles it looks for. `readExemplars` skips
them and takes the next available spec instead. A hand-edited file is never
"owned": a human's tests are genuine prior art, a re-plan should defer to them,
and the file is a legitimate exemplar. That is the conservative direction.

The second fix is the one that would have caught this regardless of cause:
`flint generate` now **refuses** when a plan emits zero tests and its spec file
already exists. Not a warning — nothing is written, and the message says the
tests would be lost and how to recover. The existing "none of these tests will
run" guard did not fire here because it checks `emitted > 0`, and this plan
emitted nothing at all. A guard with a hole exactly the shape of the failure it
was written for.

**Why the compile gate passed this time.** The stale-locator errors from the
previous run disappeared — because the file that referenced those locators had
just been emptied. The bug hid its own symptom.

**What the operator has to do:** re-run `flint plan login` and
`flint generate login`. The four cases will come back as `new` now that the
exemplar no longer shows them.

### The exemplar fix, verified live

`flint plan login` after the fix:

```
Cases: 5   new 2, skipped-duplicate 3     (was: 4, all skipped-duplicate)
```

and the suite recovered:

```
Spec files: 3 (15 tests)   Features covered: 3   Flint-managed: 7
```

The three remaining duplicates are **correct**: `example-login` genuinely covers
valid sign-in, invalid credentials, and the empty-credentials error, so `login`
deferring to them is the deduplication working as intended. What came back as
`new` is exactly what only `login` covers — the site root showing the form, and
an already-signed-in visitor still being shown it. `forcedDuplicates: 0`, so the
model made that call on real evidence rather than on Flint's own output.

Prompt input tokens rose 21,698 → 31,052, which is the fix visible in the
numbers: the exemplars are now two *other* features' specs instead of the
feature's own.

### Stale ids lived forever in the page-object record

The same run showed the stale-locator warning firing again for element ids that
died when `testIdAttribute` changed — on a run where nothing was wrong. The
record is a union across every feature and nothing ever removed from it, so
those ids would have been re-dropped and re-warned on **every** `flint generate`
from now on.

That warning is load-bearing: it is how a genuinely stale suite announces
itself. A permanent copy of it is how the one that matters gets ignored.

`pruneToModel` drops element ids the current Screen Model no longer contains,
and page objects left with nothing. It runs **only after a successful write**,
when the compile gate has just proved nothing in the suite still references
them — pruning before that would delete the record that makes the failure
diagnosable.

## Phase 5 — exit criteria VERIFIED (2026-08-13)

The operator's live run against saucedemo.

**Baseline, no repair:**

```
Tests: 15   passed 11   failed 1   skipped 3
Pass rate: 91.7% of the 12 that ran
  ✗ User can add an item to the cart from its detail page
      selector-not-found: expect(locator).toHaveText(expected) failed
```

**With `--repair`:**

```
Tests: 15   passed 12   skipped 3
Pass rate: 100.0% of the 12 that ran
Repairs:
  ✓ User can add an item to the cart from its detail page
      1. [llm] The test asserts the product name on the item detail page but uses
         InventoryHtmlPage.sauceLabsBackpackDiv, whose text locator is hard-coded
         to 'Sauce Labs Backpack' and therefore matches nothing on the Bike Light
         detail page; it must point at the verified generic item-name element
         instead.
```

**Master plan Phase 5 exit criteria, each against this run:**

| Criterion | Result |
| --- | --- |
| Post-repair pass rate ≥90% on the golden set | **100%** (12/12 that ran) |
| Env failures detected pre-run, never "repaired" | health check passed; nothing classified `env` |
| Zero infinite loops (iteration cap + wall clock) | repaired on iteration 1 of a maximum of 2 |
| Flaky detection — pass-on-retry, not repaired | isolation re-run fired; the failure reproduced alone, so repair proceeded correctly |

**The repair is correct, not merely green.** The emitter had named a locator
`sauceLabsBackpackDiv` from a *text* selector — the one non-`data-test` entry in
`InventoryHtmlPage.selectorsUsed`, visible in the previous run's suite index. The
test navigated to the **Bike Light** detail page, where a locator hard-coded to
"Sauce Labs Backpack" matches nothing. The model diagnosed exactly that and
repointed it at the verified generic `inventory-item-name` element.

Every guardrail held: the replacement came from the verified set (it is in
`InventoryItemHtmlPage.selectorsUsed`), no selector was invented, no assertion
weakened, one file touched.

**The ordering ran as designed**, visible in the timestamps: full run → scoped
isolation re-run (05:37:50) → deterministic selector retry declined → one model
call (05:37:58–05:38:32, 35.5s) → patch applied to `pages/inventory-html.page.ts`
→ scoped re-run → pass. The attempt list shows `1. [llm]` only, so the
deterministic half correctly found nothing to try before the model was asked.

**Worth noting for Phase 6:** the underlying defect is upstream of the verifier.
`locatorFor` picked a text selector for an element whose accessible name is the
product title, producing a locator that only works on one product's page. The
repair fixed the symptom in the suite; the emitter will re-introduce it on the
next `flint generate`. Recorded rather than fixed — Phase 4 files are frozen.

### One usability defect this run exposed

```
Report written to   .flint/reports/2026-08-13T05-37-42-738Z.json
$ cat .flint/reports/2026-08-13T05-37-42-738Z.json
cat: No such file or directory
```

The path was printed relative to the *project* root while the shell sat in the
Flint checkout — a line that looks copy-pasteable and is not. Same shape as the
earlier `--dir` problems: output that assumes cwd is the project. `displayPath`
now prints relative only when the file is under the shell's own directory, and
absolute otherwise.

## Phase 6 — Integration, CI & Polish (in progress)

### 6.1 `flint ci` — one batch, one gate

The Phase 0 stub is replaced. `ci` is deliberately **not** a shell loop over the
other commands, because that is exactly what failed twice on the operator's
machine:

```
plan cart; generate cart
  -> Generated code does not typecheck; nothing was written:
     tests/login.spec.ts(30,36): Property 'elCf510ff0b994Select' does not exist
```

`flint generate <feature>` gates one feature against the suite **as it
currently stands**. That is right for one feature and wrong for a full run:
whichever feature goes first meets the others' un-regenerated specs. Reordering
only moves the problem — there is no safe order, because the unit being checked
is wrong.

`emitBatch` (`src/generator/batch.ts`) emits every feature in memory, threading
the page-object records through so two features sharing a page still share its
locators, and returns one combined file set. `ci` gates that set **once** and
writes only if it passes. The unit that must compile is the suite afterwards,
and the Phase 4 guarantee — never leave a suite Flint knows does not compile —
now holds across a multi-feature run instead of only within one.

The order-independence is a property, not a hope: a test asserts that
`[login, cart]` and `[cart, login]` produce byte-identical page objects and the
same file list. If order still mattered, batching would only have moved the
problem.

**`ci` does not explore.** Exploration needs a browser, credentials and
minutes, and a CI job that silently re-crawls a live application on every push
is a surprise nobody asked for. `ci` uses the Screen Model it finds and refuses
with an actionable message when there is none.

**`--json` prints a stable machine-readable summary** — per-feature case counts,
gate result, verify totals, pass rate, repair count, report path — and the exit
code is non-zero on anything that is not a clean pass. A CI step that exits 0 on
a failed gate is worse than no CI step at all.

Flags: `--feature <id...>`, `--repair`, `--no-llm`, `--ready`, `--no-verify`,
`--json`.

### 6.2 Drift mode — "which tests does this UI change break?"

`flint explore --diff` already said what moved. On its own that is a wall of
element ids: true, and nearly useless, because the operator's question is
whether they have to do anything about it. Drift mode answers it by walking the
change back through the suite.

**The mapping** (`src/drift/impact.ts`, pure):

```
changed element -> page object that addresses it -> feature -> tests
```

Two independent links, because a suite is not always one Flint generated:

- **record** — `.flint/page-objects.json` names the element ids each generated
  page object exposes. Exact, and it carries feature ids, so it reaches test
  titles through the coverage map.
- **selector** — the Suite Index records the literal selector strings each page
  object uses. This one works for page objects Flint never wrote, which is the
  reason the index exists at all.

The selector link deliberately **ignores `role` candidates**. The Phase 2 scan
records a call's first string argument, and for `getByRole('button', { name: …
})` that is the bare role. Matching on it would report every button in the suite
as affected by any button changing; a false "47 tests break" is worse than a
quiet miss, because the operator stops reading the report.

**Severity is three-valued, and it is not decorative:**

| severity   | when                                                | meaning                         |
| ---------- | --------------------------------------------------- | ------------------------------- |
| `breaks`   | a selector the page object **actually uses** is gone | it will not resolve             |
| `likely`   | identity moved (role, name, test id, framePath)      | depends which candidate was used |
| `possible` | element intact, `states` changed                     | a visibility assertion may flip |

A lost selector the page object does not use is `likely`, not `breaks`. Added
selectors and score nudges produce no drift entry at all.

Added elements are reported as **coverage**, never as breakage. Changes that map
to nothing in the suite are counted separately rather than listed.

**One defect this found in the coverage map.** A test can appear twice: once
from the scanned spec (title with the tags the emitter appended) and once from
plan history (the planner's bare title). Unfolded, one test reads as "2 tests at
risk". They are folded on the bare title via the emitter's own `splitTitleTags`,
preferring the variant a spec file declares — that is the one the operator can
open.

**The repair: `--fix-page-objects`.** Re-emits page objects from the new model
and **never touches a spec**. That is what makes it safe rather than merely
convenient:

- *The specs are the check.* They are not rewritten, so running the compile gate
  over new page objects + untouched specs asks exactly the right question: do
  the tests still work against the new addresses? If a locator disappeared the
  gate fails, **nothing is written, and the Screen Model is not accepted either**
  — accepting it would hide the drift. The message says to re-plan with
  `flint ci`, and names the locators whose elements are gone.
- *Targeting falls out of the write layer.* Every page object is re-emitted, but
  `planWrites` reports byte-identical files as `unchanged` and never rewrites
  them. Only genuinely affected files move, without this module guessing which
  ones those are — a guess that would be wrong the moment a shared page object
  was involved.

On success the new model **is** written and the suite re-indexed, so the next
`--diff` is clean and the page objects match the model on disk.

**Exit codes.** `--diff` still exits non-zero on drift so CI can gate on it,
except when `--fix-page-objects` resolved it and proved the suite still
compiles.

**Frozen-file note (rule 2).** All logic is in new files under `src/drift/`.
`src/cli/commands/explore.ts` gained one flag and a four-line call inside the
existing `--diff` block — the wiring point `diffModels`' own doc comment named
for Phase 6 ("Phase 6 maps `changedElements` onto the Suite Index"). No schema
changed: `DriftImpact` is an internal type, not a `src/schemas/` contract.
`src/generator/batch.ts` (written in 6.1, this phase) gained `staleLocators` on
its per-feature result, which drift needs and `ci` ignores.

Tests: 21 (14 impact, 4 regenerate, 3 end-to-end). The end-to-end ones run the
real compile gate against a stubbed `@playwright/test` installed under the
suite's `node_modules` — installed rather than import-rewritten, because drift
mode emits the files itself and a missing package would make the gate *skip*,
which would make the refusal test pass for the wrong reason.

**Open question (not blocking).** Test-level precision stops at the feature: a
change to a shared page object flags every test of every feature that
contributed to it, because nothing records which spec imports which page object.
The Suite Index would need import edges to do better, and `scan.ts` is frozen.
Recorded here rather than worked around.

### The seventh instance: superseding hid the coverage map, not the test list

Found in the operator's first live `flint ci` run (2026-08-13). The run reported
success and deleted ten working tests:

```
Planning 3 feature(s): cart, example-login, login
  cart: 8 case(s)
  example-login: 8 case(s)
  login: 4 case(s)
Wrote 3 file(s) to e2e
No new tests for: cart, login — every case was a duplicate.
Tests: 3      <- the suite had 13
CI passed.
```

**Cause.** `supersedeOwnGeneratedTests` removes a feature's own generated titles
from `index.coverageMap`. The Context Builder renders the index in two places:
"Coverage by feature id" (counts, from the map) and **"Existing tests (title —
file)"**, which walks `index.specs[].testTitles` directly. The second list still
carried every title superseding had just hidden, so the planner read cart's own
five tests as prior art and marked all eight new cases `skipped-duplicate`. The
emitter then wrote a spec with nothing in it.

This is the same bug as the exemplar leak, one layer down, and the seventh time
this class has appeared: **Flint reading its own previous output as somebody
else's input.** Each time the fix has been to name one more channel through
which the previous answer reaches the question.

**Fix.** `src/planner/hide-superseded.ts` — `hideSupersededTests()` hides those
titles from `specs` as well as from the coverage map. Scoped exactly: only
titles the feature's own coverage claims, and only in **managed** files. Another
feature's generated tests stay visible (real prior art), and a hand-edited file
means a human owns those tests now, so they stay visible too. Wired into both
`flint plan` and `flint ci`, so the two commands cannot disagree.

Kept in a new module rather than inside `supersede.ts`, which is a frozen Phase 3
file (rule 2). `plan.ts` changed by one line at the same wiring point Phase 5
already extended.

### `flint ci` refuses to erase a spec — and only that

The supersede fix removes the known cause. The guard exists because there will
be others: **no amount of prompt correctness should be load-bearing for not
deleting somebody's tests.**

The first version of this guard refused any net decrease, and the operator's
very next run tripped it at 12 tests against 13 — one case had merged into
another. That is not data loss. Planning is a model call; a plan varying by a
case between runs is ordinary, and a guard that fires on ordinary variation is
one people learn to pass the override to by reflex, which costs exactly the
protection it was built for.

So the line is **zero, not fewer**. A spec that holds tests and would hold none
was not regenerated, it was erased — different in kind, and the failure that
actually happened. `src/integrator/shrink-guard.ts` compares, per feature, the
tests in the spec files it owns against what the batch would write:

```
Refusing to write: this run would erase spec files that currently have tests.
  cart: e2e/tests/cart.spec.ts — 5 test(s) would be lost
Nothing was written.
```

A merely smaller plan writes, with a note saying so. `--allow-empty` overrides
the refusal. `failedStage: 'shrink'`, `tests: { before, after }` and
`emptiedSpecs` are in the `--json` summary.

The compile gate cannot catch any of this: **an empty spec typechecks
perfectly.** That is why the guard counts tests, and why it runs before the
write rather than after the verify.

### Drift repair now admits when it did not apply

The same run hit a page object the operator had edited by hand. The writer
correctly kept their version and wrote ours beside it as
`inventory-html.page.flint.ts` — and `--fix-page-objects` still printed
"Re-pointed 2 page object file(s)" and "The existing specs still compile against
them". Both true, and together misleading: the specs import the *original*,
which still addresses the old UI. It compiles and then fails at runtime for the
reason the repair claimed to have fixed.

It now names diverted files explicitly and says the tests using them still
address the old UI.

### What the live run got right

Worth recording, because these were the things most likely to be wrong:

- `explore --diff` on an unchanged app: `No changes.`, exit 0. No false drift.
- The drift report named 13 of 13 tests as breaking for a single changed
  element. That looked like over-reporting and is not: every test in the suite
  signs in through `HomePage`, so a broken login button really does break all of
  them.
- `--fix-page-objects` re-pointed the page objects, left every spec byte
  identical, updated the model, and `flint verify` then passed 7/7 that ran.

### 6.3 Benchmark runner — the number V2 has to beat

Part D makes a V1 baseline a **prerequisite** for V2: "agentic upgrades must
PROVE improvement, not vibe it." That only works if the baseline exists before
anyone starts building the thing it judges, which is why this ships now rather
than "when we get to V2".

`flint bench` measures the pipeline end to end and writes `benchmarks/baseline.md`
(plus the same data as JSON, for diffing):

| Metric | Source |
| --- | --- |
| Compile rate | per feature, attributed from the gate's error paths |
| First-run pass | the verify run **before** repair |
| Post-repair pass | the same run after the repair loop |
| Selector re-resolve rate | `--validate` only — needs a browser |
| Tokens + est. cost per feature | recorded per call, priced from a dated table |
| Wall time per stage | measured around plan / emit / gate / verify / repair |

**It is not `flint ci --json`.** `ci` reports what a run did; bench reports what
the pipeline costs and achieves. The first-run pass rate is the one `ci`
structurally cannot give you — it repairs and *then* reports, so the pre-repair
number is gone by the time it prints. Separating them is the whole point: the
V2 claim will be "repair got better", and that is unfalsifiable without both.

**Nothing defaults to zero.** Every metric is measured or `undefined`, and
`undefined` renders as `not measured`. A benchmark that silently reports 0% for
something it never ran is worse than one that admits the gap: the first is a
false regression, the second is a to-do. The selector rate is the live case —
it needs a browser, so without `--validate` it says so rather than inventing
100%.

**Costs are quoted, not remembered.** `src/bench/pricing.ts` carries an `asOf`
date on every figure, checked against the published table rather than recalled,
and the report prints the date beside the number so a stale table announces
itself. An unknown model yields **no** cost rather than zero, and one unpriced
model makes the *total* absent rather than under-counted — a total that silently
drops a model reads as complete and is not.

**Token attribution is by call order, not by parsing `meta.purpose`.**
`RecordingProvider` decorates the real provider (so the measured path is the
production path, not a copy that could drift); the command notes `calls.length`
before each feature and slices. A purpose string is prose for humans and would
break the numbers the first time someone reworded it.

**Compile rate is per feature, not one boolean.** The batch gate is
all-or-nothing, which would make the metric degenerate. Gate errors are
attributed to features by the spec file tsc names; an error in a *shared* page
object is charged to every feature in the batch, which is the honest reading —
the batch did not compile.

Flags: `--feature <id...>`, `--out <path>`, `--validate`, `--no-repair`,
`--no-write` (measure without touching the suite), `--json`.

Tests: 16 (11 metrics, 5 recorder). The baseline itself is not committed yet —
it has to come from a live run against the demo app, which is the operator's
machine, not this sandbox.

### 6.4 Docs

`README.md`, `docs/kb-authoring.md`, `docs/config-reference.md`.

The exit criterion is that **a stranger can onboard from the README alone**, so
the README is a runnable path — install, `init`, `explore`, `ci` — not a feature
tour. It leads with the two things that actually stop a newcomer, both learned
from the operator's own runs rather than guessed:

- run commands **from the Flint checkout** with `--dir`, which was the first
  live failure of Phase 5 and cost two rounds to diagnose;
- set `explorer.testIdAttribute` before the first real run, because getting it
  wrong fails **silently** into role and CSS selectors.

The "What Flint will not do" section is deliberate. Every entry is a refusal
that exists because the alternative silently produces something worse — no
non-test exploration, no writing code that does not compile, no overwriting
hand edits, no erasing a spec, no counting a test that did not run as passing,
no patching over what may be a real application defect. A user who reads only
that section still knows the shape of the tool.

The KB guide covers what exploration cannot discover: intent. Frontmatter
table, a weak-vs-strong contrast for acceptance criteria (the highest-leverage
field), flow scripts for states no link reaches, and the two behaviours that
surprise people — superseding a feature's own previous tests, and data needs
becoming `fixme` rather than silent passes.

The config reference gives every key its default **and what it costs to get
wrong**. `testIdAttribute` and `envClass` get their own sections: the first
fails silently, the second is a safety rail with no override flag. It also
settles which `.flint` files to commit (model, plans, page-object record: yes;
run reports: no), which had not been written down anywhere.

**Note on `pnpm format:check`.** It fails on `PHASE_NOTES.md` and did so before
this phase — the file predates the prettier config and reformatting 2,400 lines
of history would destroy the diff that makes it useful. The definition of done
is `test`, `build`, `lint`, all of which are green. The new docs are
prettier-clean.

### 6.5 GitHub PR mode — `flint pr`

Both open questions answered by the operator (2026-08-14): **octokit, not the
`gh` CLI**, and **no pushing by default**.

- **octokit** — no external binary to install, behaves the same in CI as on a
  laptop, and it does not inherit whatever account someone happens to be logged
  into, which is a surprising way to decide who authored a pull request.
- **`--push` is opt-in.** By default `flint pr` creates a branch, commits, and
  prints the two commands to finish. A test generator that pushes to somebody's
  origin as a side effect of generating tests is a bad default; the blast
  radius of getting it wrong is a branch on their remote they did not ask for.

**Staging is path-scoped: `<suiteDir>` and `.flint`, never `git add -A`.** A
generator that sweeps the working tree will eventually publish somebody's
half-finished refactor or their `.env`, and they will find out from the pull
request. Unrelated changes are counted, listed, and left alone. This is the one
property with a test that could not be written against a mock, so `git.test.ts`
runs against a real temporary repository.

**The PR body leads with what ran, not what was generated.** A reviewer opening
a generated PR has one question — should I trust these tests? — and "adds 12
tests" does not answer it. First line is `**3 of 4 tests pass; 1 fail.**`, or
`**Not verified**` when the suite was not run or the app was unreachable. Every
non-passing test is named with its failure class and first error line, and
assertion failures that may be real application defects get their own section.
Blocked cases carry their reason instead of vanishing.

#### Two defects the tests caught

Both would have shipped without a real repository and a table-driven parser
test:

1. **`git status --porcelain` collapses untracked directories.** A hundred new
   spec files showed up as one line, `e2e/`, and `git add` then failed on
   `.flint` when that directory did not exist yet — which reads like a Flint
   bug and is not one. Fixed with `-uall` and by staging only paths that exist.

2. **A GitHub Enterprise remote would have opened the PR on the public repo.**
   `github.mycorp.com/acme/widgets` parses to `acme/widgets` just as happily as
   github.com does, and octokit defaults to `api.github.com` — so Flint would
   have tried to open a pull request against a *stranger's* public repository of
   that name. `parseRemote` now anchors the host to github.com exactly;
   anything else returns undefined and the command says "not a GitHub remote —
   your branch is pushed, open it in your host's UI."

**Failure handling is about not losing work.** Every error after the commit
says the commit is safe and where it is: a failed push, a missing remote, a
missing token, a GitHub refusal. The token-missing path prints the `compare`
URL so the operator can finish in one click.

Flags: `--branch`, `--base`, `--remote`, `--push`, `--draft`, `--title`,
`--dry-run`.

Tests: 35 (11 git against a real repo, 11 body, 13 remote/token parsing).

### 6.6 Four defects from the fourth live run (2026-08-14)

The operator's log of a full `ci` → `explore --diff` → `bench` → `pr` pass.
The run was mostly right — the drift severities in particular were correct, and
the shrink guard and gate both did their jobs — but it surfaced four things.

**1. The compile gate could deadlock with no way out named.** A hand-edited
`pages/inventory-html.page.ts` was diverted to `.flint.ts` (correctly). The
regenerated `cart.spec.ts` referenced members that exist only in Flint's
version, so `tsc` reported `TS2551: Property 'addToCartButton2' does not exist`
— and would report it identically on every future run, because nothing about
re-running changes which file the specs are checked against. The gate was
right; the message was useless.

`src/integrator/divert-deadlock.ts` is a pure function over the write decisions
and the tsc diagnostics: when a run diverted anything, it names both files and
the two ways out (merge from the `.flint.ts` copy, or `rm` both and let Flint
own it again). It is confident when the diagnostics carry the divergence
signature (TS2339/2551/2554/2353) and hedges when they do not — a syntax error
would have failed whether anything was diverted or not, and claiming otherwise
sends someone down the wrong path. Wired into `ci`, `bench`, and the drift
repair's refusal path.

**2. Plans were persisted before the gate ran.** `ci` wrote each plan to
`.flint/plans/` inside the planning loop, so a run that then failed the gate
left plans on disk claiming coverage for tests that were never generated. That
is why `explore --diff` reported nine tests as `(file unknown)` — it was reading
Flint's own abandoned output as evidence of a suite that does not exist. **The
eighth instance of this project's recurring bug class**, and the first one
caught before a user hit it in anger rather than after.

Plans are now held in memory and written only after `applyWrites` succeeds.
Cross-feature dedupe within a run still works, via
`src/planner/session-coverage.ts`, which supplies what the disk used to: history
for features the run is not touching, plus the plans made so far in this run.
It drops the stored plan of **every** feature in the run, not only the one being
planned — those plans describe the suite as it was before the run and are about
to be replaced, so deduping against them is the same mistake `excludeFeature`
exists to prevent, one feature over. Same change in `bench`. `store.ts` was not
modified (frozen, Phase 3).

**3. Drift's repair message contradicted itself.** It printed "Re-pointed 1
page object file(s)" from `applied.written` — which counts diverted files —
and then, three lines later, "NOT applied to these". The count is now
`written - diverted.length`, with a distinct sentence for the case where every
file that needed rewriting is one the operator has edited.

**4. `bench` wrote a baseline from a failed run.** Compile rate 66.7%, pass
rates "not measured", and a file called `benchmarks/baseline.md` that reads like
the number V2 must beat. `provisionalReasons()` now derives the problems from
the report itself, `formatBaseline` puts a warning block **above** the headline
table, and the CLI repeats it after the write. The exit code was already 1;
that was not enough, because the file outlives the terminal.

Also fixed: `PHASE_6_TESTING.md` §5 told the operator to `git -C $DEMO add` in a
directory `flint init` never made a repository. `flint pr` refused correctly —
that was a guide defect, not a Flint one.

Tests: 942 across 68 files (+19).

### 6.7 Three defects that need frozen files changed (2026-08-14)

Found in the fifth live run. All three are one-to-three-line fixes in completed
phases, so per working rule 2 they are recorded here rather than made.

**A. `pino` writes to stdout, so `--json` output is not parseable.**
`src/shared/logger.ts` (Phase 0) creates the logger with no destination, which
means `process.stdout` — the same stream the CLI prints its human output and its
`--json` summary on. Two consequences, both visible in the operator's log:
structured log lines land in the middle of prose and out of order (`plan:
generated` printed *after* `CI failed at the gate stage.`), and roughly sixty
blank lines appeared inside a single message because two buffered writers were
sharing one fd. The functional half is worse than the cosmetic half: anything
piping `flint ci --json` into `jq` gets log lines mixed into the object, and
`--json` for CI consumption is a Phase 6 exit criterion.

Fix: `pino(options, process.stderr)`. Diagnostics belong on stderr; stdout is
the product. Reproduced locally — `console.log`/`logger.info`/`console.log`
prints `BEFORE`, `AFTER`, then the log line.

**B. The repair loop rewrites managed files without re-stamping the marker.**
`src/verifier/repair-runner.ts` (Phase 5) writes with plain `writeFileSync` at
two points — the selector/LLM repair's `writeFile` dependency, and the `fixme`
marker writer. `withMarker` is called in exactly one place in the codebase,
`integrator/writer.ts`. So a repaired file keeps the hash of its *pre-repair*
content, `classify()` returns `hand-edited`, and the next `ci` run diverts it to
`*.flint.ts` and fails the compile gate — permanently.

**This is the ninth instance of the recurring class: Flint reading its own
previous output as somebody else's input.** It is also the actual cause of the
operator's stuck `inventory-html.page.ts`: the locator swap in that file
(`addToCartButton` moved from the bike-light testid to the backpack testid) is
exactly what the deterministic selector retry does. Nobody hand-edited anything.

Fix: re-stamp with `withMarker` at both write sites.

**C. `flint init` scaffolds no `.gitignore`.** The generated suite has its own
`node_modules` (installed deliberately — `@playwright/test` is the suite's
dependency, not Flint's), so a scaffolded project's first commit sweeps in about
seven hundred vendored files. `src/cli/scaffold.ts` is Phase 0.

Fix: scaffold a `.gitignore` covering `<suiteDir>/node_modules/`,
`test-results/`, `playwright-report/`, `blob-report/`, `.DS_Store` and `.env`.

#### Fixed now, in Phase 6 code

- **`flint pr` would have committed `node_modules`.** Staging is path-scoped to
  `<suiteDir>` and `.flint`, which is correct, but git decides what inside those
  paths matters from `.gitignore` — and there is none (defect C). `git add --
  e2e` would therefore vendor the whole dependency tree into the pull request.
  `src/pr/vendored.ts` refuses, names the offending segments, and prints the
  `.gitignore` to write. Refusing rather than silently excluding: the missing
  ignore file is the real defect and the operator needs it for their own
  `git status`, not just for Flint's commit. Segment-matched, not substring —
  `pages/node_modules-viewer.page.ts` is a test file.
- **The divert message blamed the operator for an edit Flint made.** Given
  defect B, "you have edited them" is often false. It now says the contents no
  longer match the marker Flint last wrote, and names both causes.
- `PHASE_6_TESTING.md` §5–6: the guide told the operator to `git add -A && git
  commit` before `flint pr`, which commits the generated suite and leaves `pr`
  correctly reporting nothing to propose. My error, not Flint's.

#### Also observed, not defects

`kb/features/example.md` ships with `flint init` and plans a full second login
feature (`example-login`, 5 cases) alongside the operator's own `login`. Worth
deleting from a real project; worth reconsidering as a scaffold default.

### 6.8 The three frozen-file fixes, approved and made (2026-08-14)

Operator approved all three from 6.7, plus removing the scaffolded example
feature. Recorded here because rule 2 exists to make changes to completed
phases visible, not to prevent them.

**A. `pino` now writes to stderr** (`src/shared/logger.ts`, Phase 0). Verified
end to end: `flint ci --json` piped into a JSON parser now parses, where before
the log lines landed inside the object. Diagnostics on stderr, product on
stdout — which also ends the interleaving, since two separately buffered writers
no longer share one fd.

**B. Repair re-stamps the managed marker** (`src/verifier/repair-runner.ts`,
Phase 5). `restamp()` at both write sites — the repair loop's `writeFile`
dependency and the `fixme` writer. It deliberately does **not** stamp an
unmarked file: repair is allowed to fix a hand-written page object, but adopting
one would let a later run overwrite somebody's own code without warning.

This was the operator's stuck `inventory-html.page.ts`, and the ninth instance
of the recurring class. `repair-runner.test.ts` (6 tests) pins it, including the
inverse assertion — that an un-restamped file classifies as `hand-edited` — so
the test still means something if `classify` ever changes.

**C. `flint init` scaffolds a `.gitignore`.** Stored in the template tree as
`gitignore` and dotted by `destinationFor()` on the way out, because npm renames
`.gitignore` to `.npmignore` inside a published package — a template under its
real name would work from a git clone and silently vanish for anyone who
installed from the registry. It ignores `e2e/node_modules/`, the three Playwright
output directories, `.DS_Store`, `.env`, and `.flint/auth/` — but **not** the
rest of `.flint/`: the Screen Model and the plans are the record of what the
suite was generated from, and reviewing a change to them is the point.

**D. `kb/features/example.md` is now `_example.md`.** The `_`-prefix skip
already existed for feature specs (`discoverFeatureFiles`), matching the
flow-script convention — so this is a rename, not a deletion, and the worked
example survives while costing nothing. It was planning a fifth-and-sixth test
case for a duplicate `example-login` feature on every single `ci` run: roughly
27k input and 3.2k output tokens per run, about $0.22 at Opus 5 list, for tests
nobody wanted. Documented in `docs/kb-authoring.md` and the README quickstart.

#### Checked and left alone

The `temperature`-rejection retry costs one extra request per process, but the
API rejects it with a 400 before generating anything, and the model id is
remembered for the rest of the run (`anthropic.ts` already caches it). Latency,
not money. No change.

Tests: 957 across 70 files (+15).

### 6.9 Live verification of the 6.8 fixes (2026-08-14)

Operator re-ran the pipeline. **The deadlock is gone**: the compile gate passed,
13 tests emitted, 11 ran, 11 passed, 1 skipped, 1 fixme, and `flint ci` exited
clean. `bench --validate` recorded the V1 baseline — compile rate, first-run
pass, post-repair pass and selector re-resolve all 100%, $0.22 per feature,
93.9s wall.

Three things the run surfaced.

**A. `--json | jq` still failed, and it was my instruction, not the logger.**
The stderr fix works — the pino lines appeared on the operator's terminal while
stdout was piped away, which is the proof. What broke `jq` was `pnpm run`
printing its own `> flint@0.0.0 cli` banner to stdout, ahead of the JSON.
Confirmed locally: `pnpm cli --version 2>/dev/null` emits four lines of banner
before the version. Fixed in the docs (`pnpm -s`), not in the code — an
installed `flint` binary was never affected, and Flint should not be papering
over its package manager.

**B. The baseline had a row that did not add up.** `login` showed 5 cases, 0
degraded, 3 live tests. Nothing was wrong — two cases duplicated tests `cart`
had already emitted, and `liveTests = cases - skippedDuplicates - degraded` —
but `skippedDuplicates` was computed and then dropped before rendering. A
document whose stated purpose is "V2 has to beat these numbers" cannot have
rows that need the source open to interpret. Added a `Deduped` column; the four
per-feature counts now reconcile, and a test asserts it.

**C. Planning is not deterministic, and CLAUDE.md says it must be.** Left for
the operator to decide — written up below rather than fixed, because the fix is
architectural.

Three runs over *identical* input (same Screen Model, same specs, no edits
between):

| Run | cart cases | cart out-tokens | cart degraded | login cases | login out-tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| `ci` | 6 | 5156 | 1 | 5 | 3051 |
| `ci --json` | 6 | 6128 | 2 | 4 | 2583 |
| `bench` | 6 | 5284 | 2 | 5 | 2613 |

`login` produced five cases, then four, then five. The suite is different every
run.

The cause is in plain sight in the logs: `model rejects the temperature
parameter — retrying without it`. `claude-opus-5` refuses `temperature`, so
`anthropic.ts` correctly drops it and retries — and the request then goes with
no temperature field at all, which means the API default, not 0. The retry is
right; what is missing is that nothing noticed the determinism rule had been
silently voided. "Regenerating identical input must produce byte-identical
output" (CLAUDE.md, locked) is currently false for any feature spec.

Note the emitter is not implicated: it is pure templating and is byte-identical
given a plan. It is Stage A that varies, and the emitter faithfully turns a
different plan into a different suite.

This is a `PHASE_NOTES` question per rule 7, not a unilateral change: the
options (accept and document; pin an older model; cache plans by input hash)
differ in cost, and the third is the one that also fixes the ~$0.45 every `ci`
currently spends re-planning work it already has on disk.

Tests: 961 across 70 files (+4).

### 6.10 Plan cache (2026-08-14)

Approved by the operator. `flint ci` now reuses a feature's stored plan when
nothing that shapes it has changed, and makes no model call at all on an
unchanged re-run.

**The key is the rendered prompt plus the model id.** Deliberately not a list of
inputs: the prompt is already a pure function of the spec, the matched Screen
Model pages, the conventions, the Suite Index summary, the exemplars and the
template version, so hashing it covers every one of those and cannot rot when a
section is added to the context builder. Rebuilding the prompt to compute the
key is pure CPU, and doing it in a new module rather than inside `generatePlan`
leaves Phase 3 frozen.

**The entry stores the key, never the plan.** `.flint/plans/<feature>.plan.json`
stays the single copy, so a human who tightens an assertion by hand gets their
version rather than a cached duplicate of the original. A missing, deleted or
unparseable plan is a miss, never an error.

**The entry is written by the caller, only once the plan is persisted.** This
was a bug in my first draft, caught before wiring: `ci` holds plans in memory
until the compile gate passes, so writing the key at planning time would leave a
key describing plan B beside plan A still on disk from the last good run — and
the next run would serve A as though it were B. The tenth instance of the same
class, and this time in code I was writing to fix the ninth. Key and plan are
now written in the same loop, and a test asserts `generatePlanCached` writes
nothing itself.

**Two commands deliberately do not use it.** `flint plan` is the explicit "plan
this now" command. `flint bench` measures what a feature costs, and a benchmark
reporting $0.00 because it reused yesterday's answer would be measuring nothing.

This is the determinism fix from 6.9, arrived at from the other side: it does
not make the model repeat itself, it stops asking twice. `--replan` forces a
fresh plan.

Tests: 976 across 71 files (+15).

### B1 — Suite Manifest (2026-08-17)

First phase of the Bubblegum dialect (`BUBBLEGUM_PLAN.md`). `flint manifest`
inventories what a suite can already do: flows with their JSDoc summaries,
params, return types and the `act`/`verify` phrases they issue; data exports
with their keys; helpers; credential getters; repositories with their public
methods.

**Why this comes first.** Flint's locked principle is *ground before you
generate* — the model may never invent a selector, and every `elementRef` is
checked against the Screen Model before code is written. Bubblegum has no
selectors, so the rule moves rather than disappearing: the thing that must not
be invented becomes the **flow**, and the manifest is the evidence. A model
asked for a login test will call `loginToPortal()` when the export is named
`loginFlow()`, and the result compiles, imports nothing that exists, and fails
at run time.

**Derived, never authored.** Regenerated on every run and rewritten after
generation by re-scanning. A hand-maintained inventory goes stale the first time
somebody renames a function, and a stale one is worse than none — the
referential check would then reject valid code and accept invented code. This is
the same failure this project has produced nine times under other names, so the
manifest is designed so it cannot happen.

**No model calls.** Names come from declarations, summaries from JSDoc, phrases
from string literals. A suite following the four-layer convention already
documents every flow, so the semantic layer is free. That is what makes
regenerating it on every run affordable.

Three decisions worth recording:

- **Syntax pass, no type checker.** The suite being scanned belongs to somebody
  else and may not compile — an unresolved workspace import in a monorepo is the
  normal case. An inventory is most wanted exactly when the build is broken.
- **Dynamic imports are resolved.** The four-layer test template must use
  `await import(...)` so `dotenv` runs first. A scanner reading only static
  imports would report every flow as unused and leave the reuse check with
  nothing to work with.
- **Template holes are preserved.** `Enter "${creds.username}" into Username`,
  not `Enter "" into Username` — the second reads as a bug in the suite and
  would teach the generator the wrong shape.

Credential getters are matched by naming convention rather than by return type,
because the type is an inferred object literal in an unresolvable file. A false
positive costs one extra name in a list; a false negative means an invented
getter and a test that cannot log in.

**Verified locally** against a four-layer saucedemo fixture (2 flow files, 1
data file, 2 helpers, 2 credential getters in `packages/data`, 1 repository in
`packages/utilities`): 4 flows found with correct kinds, phrases, params and
`usedBy`; `login.logoutFlow` correctly reported as imported by no test.

Tests: 1014 across 73 files (+38).

### B1.1 — A silent failure, caused by my own advice (2026-08-17)

Operator ran `flint manifest` against the real project and got **no output at
all**. Not an empty summary — nothing, exit 1.

The cause was the `2>/dev/null` in the command I gave them. Errors go to stderr,
as they should; the redirect I recommended to hide pino's progress line was
discarding them too. Reproduced exactly: missing `flint.config.ts` → clear
`ConfigError` on stderr → thrown away → silent exit 1.

Bad advice on my part, and it came directly from 6.8: I moved logs to stderr,
then told someone to suppress stderr. Three changes so the advice is no longer
needed and the failure mode is no longer silent.

**The scan's progress line is now `debug`, not `info`.** It only duplicated the
summary already printed to stdout, so at info level its sole effect was putting
a JSON blob on stderr that tempts people into `2>/dev/null`. Quiet stderr on
success is what keeps stderr worth reading on failure.

**A path that does not exist is now a warning, named with its resolved absolute
path.** This was the next trap waiting: a mistyped `suiteDir` scans nothing and
returns a perfectly valid manifest full of zeros — indistinguishable from a
greenfield project, which is a legitimate empty result. `packages/web-tests/src/
smart-tests` looks right until you see what it resolved against.

**The summary reports path problems above the counts**, and the CLI's closing
message distinguishes the two cases: "nothing to reuse yet, this is a new suite"
versus "no files were scanned, fix the paths marked !". The first is
encouragement, the second is an error, and printing the first when the second is
true is how someone spends an afternoon debugging a typo.

Missing paths are no longer repeated under "could not be parsed" — nothing was
parsed because nothing was there, which is a different fault.

Tests: 1023 across 73 files (+9).

### B1.2 — The scanner was reading half the codebase (2026-08-17)

Ran against the real project: 20 flows, 16 data exports, 9 helpers, 21
credentials, 24 repositories — every count matching the operator's own
inventory. Then the repository detail arrived and 20 of the 24 exposed nothing
but `getInstance`.

That was about to become a finding: "the framework has no seeding methods, so
state-dependent JIRA cards cannot be automated." It would have been wrong, and
it would have redirected two weeks of work.

`ClassDeclaration.getMethods()` returns `MethodDeclaration` nodes only. A method
written `deleteRoadshowByName = async () => {}` is a `PropertyDeclaration` with
an arrow initialiser, and was invisible. Verified directly against ts-morph
before changing anything rather than assuming.

The same gap ran through the whole scanner, and the flow case was worse than the
repository case: `readFlows` only looked at `FunctionDeclaration`, so a suite
written `export const loginFlow = async () => {}` would have reported **zero
flows** — and the manifest would have told the generator, with total confidence,
that there was nothing to reuse. It would then have duplicated every flow in the
suite, which is precisely the failure the manifest exists to prevent.

Fixed by unifying on `exportedCallables()`, which returns both shapes with one
interface. Flows, helpers and credential getters all read through it now;
repositories get the equivalent via `repositoryOperations()`. `getInstance` is
kept rather than filtered — noise for the generator, but omitting it would make
the manifest disagree with the source, and a reader comparing the two should
find them identical.

The lesson worth keeping: the counts all matched the operator's documentation,
which is exactly why this nearly passed. Totals agreeing is not evidence that
the contents are right.

Tests: 1028 across 73 files (+5), including the arrow shape for flows,
repositories, credentials, and a mixed-shape file.

**Still open:** whether seeding methods exist. `RewardRepository.insertHealthPoints`
is the only clearly seed-shaped operation in the pre-fix data. Re-run needed
before drawing any conclusion.

### B1.3 — What the real project actually contains (2026-08-17)

Re-ran after the arrow-function fix. Flow count stayed at 20, so no flows had
been missed — that suite writes every flow as `export async function`. The
repositories changed completely: `RoadShowsRepository` went from 1 method to 20,
`UserRepository` to 30. Total across 24 repositories: **215 methods**, where the
pre-fix scan saw roughly 40.

**The seeding question is answered, and my worry was wrong.** 14 methods create
rows, 29 update them:

- `UserRepository.updateGAQ` — the exact precondition HPBPPH-17170 turns on
- `EventsRepository.backDateEventAndSession`, `updateRoadShowEventStartAndEndDate`,
  `updateSurveyStartTime`, `updateGoalConfiguarationStartTime` — time-shifting,
  which is what lifecycle ACs ("today's date > visibility period") need
- `ChallengeRepository.insertChallengeProgress`, `RewardRepository.insertHealthPoints`

The one real gap for that card: `ActivityRepository` can `deleteMVPA` but has no
insert, so "user has synced some MVPA progress" has no DB path. Roughly half
that card's ACs are reachable; the progress-dependent ones are not, without an
API or app sync.

**One classification miss.** `event-creation.approveActivityByPM` fell into
`other`. Added a `transition` kind, checked before `create` so `submitForApproval`
reads as the state change it is rather than a creation. Admin portals are full
of these, and filing them under `create` would offer the planner an approval
flow when it asked how to make something.

**One documentation gap in their suite,** which is exactly what the manifest is
for surfacing: `login.logoutFlow` is the only flow with no JSDoc, so it reaches
the planner as a bare name. Not Flint's to fix, but worth reporting.

Two observations for B3:

- Flows return their created entity inconsistently — `createRoadshow` returns
  `Promise<string>`, `createBadge` returns `Promise<void>` and carries the name
  in a Bubblegum session variable (`{{timestamp as badgeInternalName}}` then
  `{{$badgeInternalName}}`). The emitter has to support both, and the manifest's
  `returns` field is what tells it which.
- The phrase corpus is substantial: 24 phrases in `createBadge`, 60 in
  `createEdshChallenge`. That is a strong style exemplar for the Stage B prompt.

Tests: 1034 across 73 files (+6).

### B2 — Knowledge base + gap report (2026-08-17)

`flint kb` reads `kb/app/`, resolves every feature's declared data needs against
it, and reports what cannot be grounded. Static, deterministic, no model call.

**No LOCKED schema was changed, and the reason is worth recording.** The obvious
design was a `setup:` block in feature-spec frontmatter, which would have needed
a change to `kb.ts` and explicit approval. But the schema already has
`dataNeeds` — "declared data prerequisites" — and the master plan describes it
for exactly this ("plan declares dataNeeds so humans see required test data").

Using it is also the better design independent of the schema rule. "How does a
test reach GAQ-unfit" is a fact about the application, not about one feature; a
dozen specs will need it. A per-spec `setup:` block would copy the same answer
into a dozen files and guarantee they drift. It is written once in
`kb/app/entities/gaq.md` and referred to in prose.

**Design decisions:**

- **Prose matching, not a DSL.** A tester writes "a user whose GAQ status is
  unfit", not `gaq:unfit`. Matching is on whole words against the entity id and
  its aliases, with hyphens and spaces treated alike so `partial-fit` in the KB
  meets "partial fit" in a spec. Longest match wins, so `partial-fit` beats
  `fit`. A syntax strict enough to be unambiguous would simply not be used.
- **`unreachable:` is a first-class answer.** Without it the planner cannot tell
  "nobody has written this down" from "there is no way to do this", and will
  plan a test that can never pass. The MVPA case is real: `ActivityRepository`
  can `deleteMVPA` but has no insert.
- **The KB is checked whole, not only where a feature touches it.** A state
  nobody needs today still names a method, and a rename last week already broke
  it. Checking only the current spec's path means finding these one at a time,
  months apart, each time blaming whichever spec was unlucky.
- **`near()` had to be rewritten mid-phase.** Substring matching missed the
  mistake people actually make — right noun, wrong verb (`setGAQStatus` for
  `updateGAQ`), which share no substring. Now compares meaningful words with
  generic ones (`get`, `update`, `Repository`, `Credentials`) discarded first,
  since otherwise every repository suggests every other repository on the
  strength of the word "Repository".
- **Everything is forgiving.** A malformed entity file is a warning; one bad
  role does not cost you the other twenty; an absent KB is an empty report. This
  knowledge gets written by people while they are trying to do something else,
  and a reader that demanded perfection would ensure it was never written.

**Verified locally** on a BAP-shaped fixture: 3 needs grounded (two via
`UserRepository.updateGAQ`, one via an existing flow), the MVPA dead end
reported with its reason, an undescribed entity reported with candidates, and a
KB-wide broken flow reference caught that no feature referenced.

Tests: 1074 across 75 files (+40).

### B2.1 — "Nothing checked" is not "everything passed" (2026-08-17)

First run against the real project printed `All 0 declared data need(s) are
grounded.` for a repository with no feature specs at all. Technically true, and
it reads as a pass — someone whose specs sat in the wrong directory would take
it as confirmation and move on.

Third time this class has appeared: the empty manifest that looked like a
greenfield project, the silent exit that looked like a clean run, and now this.
The shape is always the same — an absent input produces a well-formed empty
result, and the summary describes the result rather than the absence.

Now three distinct messages: no specs found at all; specs found but none
declares `dataNeeds`; and every declared need grounded. Only the third is a pass.

Tests: 1076 across 75 files (+2).

### B2.2 — Two gaps found by writing a real spec (2026-08-17)

Wrote feature specs for HPBPPH-17169 (BAP customer care, Unfit MVPA column)
against the real manifest. Two omissions surfaced immediately, both invisible
until a genuine card was tried.

**Credential getters that break the naming convention.** The scanner matched
`^get.*Credentials$`, and the operator's `BAP.ts` also exports
`getCustomerSupportLevel1()` — same job, different name. Missing it means the
generator invents a getter, or a `roles.md` entry naming the real one gets
reported as a broken reference. A second signal now applies: a `get`-prefixed
function whose returned value is an object literal with `username` and
`password`. Following the returned identifier matters — these files are written
as `const byEnv = {...}` at module level with the getter returning `byEnv[env]`,
so the literal is not inside the function at all.

**Roles were not resolvable as data needs.** `checkKbGaps` only matched
`dataNeeds` against entities, so "a BAP user with the customer care role" — the
most common precondition in the card — came back as undescribed, even with
`roles.md` written and correct. Roles are now matched first, by id or alias, and
ground to their credential getter.

Both are the same lesson as B1.2: the fixtures were right and the code was
wrong in a way only real input exposes.

**The card's verdict, which is the point of B2.** Of nine ACs, four are H365
mobile and out of scope. Of the five BAP ones, AC1 (column exists after the MVPA
column) needs no data at all and is automatable today; AC2–AC5 all need MVPA
synced against a known GAQ status on a known date, and `ActivityRepository` has
`deleteMVPA` with no insert. Split into two specs so the first ships now rather
than waiting on the seeding question.

Tests: 1084 across 75 files (+8).

### B2.5 — `flint draft` (2026-08-17)

The operator pushed back on B2's delivery, correctly. Their model of the tool is
three inputs — the requirement document, application knowledge, code knowledge —
where two are derived and one is provided. I had built the checker and then
hand-written five KB files myself, which contradicted that and would have been a
per-card chore forever.

Almost nothing in those files needed a human. The states came from the card
("fit (1) or partial fit (2)… unfit (3)"), the setup path came from a manifest
method whose name contains GAQ, and the `unreachable` reason for MVPA was a fact
Flint had already computed in B1. It was a mechanical join of card × manifest.

**The design point: the model proposes, Flint disposes.** The draft schema
deliberately does not mirror the KB schema. A drafted state carries a free-text
`setupHint`; the real KB carries `repository: UserRepository.updateGAQ`. The
model says what needs to happen and Flint decides what it is called, by matching
against the manifest. Anything unmatched is written as a TODO carrying the
model's own words, never as the nearest plausible method — `setGAQStatus` reads
exactly as convincingly as `updateGAQ`, and promoting a near miss to fact would
produce a knowledge base that looks finished and is quietly wrong.

**Never overwrite.** A file on disk was reviewed by a human; a draft is a first
guess. Collisions land as `.draft.md` beside the original and are reported.
Silently replacing a corrected file would make the review step pointless and
would be indistinguishable from the tool working.

**Review is not a temporary limitation.** HPBPPH-17169 has nine ACs, four of
which describe a mobile app this suite cannot drive; it carries unresolved
reviewer comments; and two credential getters could plausibly satisfy "customer
support roles". A generator that turned all nine into tests would be worse than
one that says which half it skipped. `outOfScope` and `openQuestions` are
first-class fields for that reason.

**Verified end to end** against the real card. The live model call could not run
in this environment (no API key), so the run used a simulated response through
`FakeProvider`; everything downstream is real. Output: 2 specs, 2 entities, 1
roles file; `mvpa-data.synced` correctly unresolved with candidates listed;
the ambiguous role flagged; AC6–AC9 listed as out of scope. Feeding that KB
straight into `flint kb` reports 4 grounded, 1 gap — the MVPA seeding gap, which
is the true state of the world.

Tests: 1102 across 76 files (+18), including a round-trip asserting that what
B2.5 writes, B2 reads without warnings.

### B2.5.1 — The draft prompt never asked for JSON (2026-08-18)

First live run failed: `No JSON object or array found in model output`, after
two attempts costing 10,369 output tokens. Both attempts ended `end_turn`, not
`max_tokens` — the model finished happily and produced no JSON at all.

My prompt-authoring error. `draft-kb.md` described the fields in prose and never
showed the output shape or said "return JSON". `plan-stage-a.md` has had an
explicit `# Output` section with the full JSON skeleton since Phase 3; I wrote a
new template and did not carry that across.

The provider does append `Respond with a single valid JSON value only` to the
system prompt, which is why this passed every test — `FakeProvider` returns
whatever it is told regardless of the prompt. That one line is not enough when
the user prompt ends with 45k tokens of conversational JIRA card: a card full of
reviewer comments reads like something to reply to, and the model replied.

Two changes:

- An `# Output` section with the complete JSON skeleton, every field named.
- **Placed after the document**, so the last instruction before generation is
  what to return. `plan-stage-a` gets away with `{{context}}` last because its
  context is structured Screen Model data; a requirement document is prose that
  invites a prose answer.

Tests now render the template and assert both the contract and its position
relative to the document. A prompt is code — the ordering is the fix, not
decoration, and it deserves a test that fails if someone moves it back.

**Also added: an oversized-document warning.** The operator's JIRA XML export
measured 49,705 input tokens where the same card as plain text was under 3,000 —
a 16x multiple of markup, billed on every run. `documentWarning` says so once,
naming the extension, rather than letting it pass silently.

Tests: 1108 across 76 files (+6).

### B2.5.2 — First working draft, and what it got wrong (2026-08-18)

`flint draft` ran against the real card twice. Both succeeded. 21,443 in /
11,235 out on one export, 20,381 / 7,875 on the other — about $0.12–$0.16 a card
at Sonnet 5 list. The markdown export cut total input from 49,705 to ~21,000;
the rest is the manifest listing, which is large for a 24-repository monorepo.

**What it got right is the part I expected to be hardest.** The scope split was
sharp: it separated the H365 mobile ACs from the BAP portal ones by reasoning
from the flow listing ("the suite's flow listing contains only admin-portal
journeys… no H365 end-user app flows"), and it flagged
"customer care cannot manually enter MVPA data" as untestable because no such
screen appears anywhere in the suite. It also spotted `GenericRepository.executeQuery`
as a possible seeding escape hatch, which I had not thought of.

Most striking, one open question read: *"Ada Wong's first comment questioned
whether unfit MVPA data is visible on H365 'or BAP' — the resolution in the
thread is ambiguous ('you're right on both items' refers to a different
sub-question)."* That is exactly the class of thing I argued review exists to
catch, found by the tool.

**Three mechanical faults, all fixed here.**

- **Feature ids up to 56 characters**
  (`activity-data-mvpa-split-on-gaq-status-change-within-day`). The prompt said
  "make sense in a year" and it overcorrected. This is not cosmetic: the id
  becomes the spec filename and the `@feature:<id>` tag printed beside every
  test result for the life of the suite. Now capped at 48 in the schema — a
  failed parse costs one short retry — with "three or four words" and a
  worked contrast in the prompt.
- **Over-splitting.** One run produced three features where two ACs differed
  only by which column a value lands in. The abstract rule ("requirements that
  differ only by data belong in one feature") was already there and was not
  enough; it now carries the concrete shape.
- **Entity proliferation.** `h365-user` and `tracker` were proposed as entities
  — nouns from the document that no test would ever set up. The prompt now
  makes that the test: would a test have to *set this up* before it could run?

The two runs also disagreed on entity naming (`gaq` vs `gaq-status`), which
matters because a rename means a re-draft proposes a duplicate rather than
extending. The existing-KB context handles this on a second run against a
populated `kb/`; it cannot help when two different exports of one card are
drafted into an empty one.

Tests: 1114 across 76 files (+6).

### B2.5.3 — Fixing one splitting rule broke the other (2026-08-18)

Third run on the same card: ids sane (`fit-unfit-mvpa-column`, 21 characters),
entities down to `gaq` and `mvpa-data`, `h365-user` and `tracker` gone,
`unresolved: 0` — the model read the manifest, found no MVPA insert, and marked
the state `unreachable` rather than inventing a hint. Every fix from B2.5.2
landed.

And the feature count went 4 → **1**.

The card has roughly five BAP-side acceptance criteria. One of them, the column
appearing after the MVPA column, needs no data at all; the rest need MVPA synced
against a known GAQ status, which the manifest says is impossible. Those are
precisely the "different preconditions" case the prompt already called out —
but I had just strengthened the *merge* rule ("requirements that differ only by
data are one feature") with a worked example, and it swamped the split rule.
The one requirement that could ship today is now locked in with four that
cannot.

Three changes:

- **Explicit precedence: preconditions win.** Merge on shape, split on what it
  takes to run. Two requirements that differ only by data still belong apart if
  one needs setup the other does not — merging buys tidiness and costs a feature
  that could have shipped.
- **Nothing may disappear.** Every requirement ends up in exactly one place: a
  feature's `covers`, or `outOfScope` with a reason. Neither is worse than a bad
  split, because a bad split is at least visible.
- **The summary now prints each feature's `covers`.** This is the fix that
  matters most, and it is not about prompting. The run above printed a file
  count and nothing about the split, so "collapsed five requirements into one"
  and "dropped four of them" produced identical output — I could not tell which
  had happened from the log, and neither could the operator. The evidence a
  reviewer needs was being computed and thrown away.

Tests: 1118 across 76 files (+4).

### B2.5.4 — The two halves were writing and reading in different registers (2026-08-18)

Fourth run, this time on HPBPPH-17236 — a genuinely web-only BAP card ("allow
Vendor Admins to view the Vendor Facilitator listing"). 18,532 in / 7,188 out,
four files written, `unresolved: 3`.

Then `flint kb` on the same directory: **0 grounded, 3 gaps.**

Every gap was `unknown-state`, and every one of them was `flint draft`'s own
output failing `flint draft`'s own output:

| `dataNeeds` written by draft | `states` written by the same draft |
|---|---|
| "a BAP user with Vendor Admin role who is not assigned the HPB Activity Vendor User Manager role" | `h365-vendor-admin-without-manager` |
| "…not assigned the Partner PA Activity User Manager role" | `partner-pa-vendor-admin-without-manager` |
| "existing vendor facilitator records under at least one company, so the listing page has rows to display" | `listed-under-company` |

`matchState` looks for the state's name *inside* the need sentence. None of
these appear in theirs, so none can ever match. Neither half is wrong on its
own — the prompt asks for needs "as a tester would say it out loud", and the
state names are perfectly good filenames — and nothing anywhere said the two
had to be written in the same words. B2 and B2.5 were built two commits apart
and never had to agree.

The scoring is the part worth remembering: a draft that is complete and correct
in substance scores **zero**, and the only place that shows up is a second
command the operator may not run.

Four changes:

- **`draft-check.ts` — the draft is checked against itself.** Every generated
  `dataNeeds` entry goes through the *same* `matchRole`/`matchEntity`/`matchState`
  the gap report uses, against the drafted KB plus whatever `kb/` already holds.
  Deterministic, no model call. The summary now prints "Preconditions that will
  not ground" with the states that were on offer, so a self-inconsistent draft
  is visible at the moment it is written.
- **The prompt says grounding is word matching** (v5), with the failing pair
  above and its fix (`a vendor admin without manager access` ↔ `without-manager`)
  written out. The rule that matters: the state name has to fit inside the
  sentence, not the other way round.
- **"Who is logged in is a role, not an entity."** Two of the three gaps were
  logins modelled as an entity with states. `roles.md` was written and nothing
  grounded through it; the states became TODOs nobody can close, because there
  is no repository method for "be a Vendor Admin".
- **No candidates for a hint that is a sentence.** `near` compares names — the
  right noun with the wrong verb. Given "Log in as a user assigned the Vendor
  Admin role…" it offered five repositories about dashboard goals, on the
  strength of sharing the word "user". Over 8 words, `hintCandidates` now
  returns nothing; silence is the more useful answer, and it stops the honest
  suggestions beside it looking equally arbitrary.

Also fixed in the prompt: `pages` is a URL fragment matched against explored
screens, not a screen's display name. The run wrote
`pages: - Facilitators tab / Facilitator listing page (h365-portal)`, which
matches nothing and would point the planner at no page at all.

Still open, and still blocking B3: the `Element.section` / `inDialog` schema
decision. Bubblegum disambiguates repeated labels in English ("… in the GAQ
requirement section", "… in dialog"), and `Element` carries neither field.
Phase 0 schemas are LOCKED, so this needs explicit approval.

Tests: 1131 across 76 files (+13). The 11 failing files in this container are
all `src/explorer/*` and fail on Chromium launch — environmental, unrelated to
this change.

### B2.5.5 — A guessed credential is not a gap, which is why it needs a marker (2026-08-18)

`flint draft` matches the role a document describes ("Vendor Admins") against
the credential getters the suite exports. Often more than one fits — the live
run offered `getBAPActivityVendorAdminUserCredentials` and
`getActivityVendorAdminCredentials` and could not tell them apart, because
nothing in the card says which account holds the access.

Until now the guess was written as fact and the doubt was printed once, in a
"Needs a human" section of `roles.md` that nobody re-reads. That is the worst
possible place for it: the getter *exists*, so `checkKnowledgeIntegrity` passes,
`flint kb` reports zero gaps, and every test built on the role runs — as the
wrong user, failing an access assertion that is actually correct.

`RoleDoc` gains an optional `review?: string`, written beside `credentials`
whenever the getter was chosen by name rather than named by the document:

```yaml
roles:
  - id: vendorAdmin
    credentials: getActivityVendorAdminCredentials
    review: more than one getter could fit "Vendor Admins" — …. Confirm which
      account has the access, then delete this line.
```

`flint kb` prints these under "Waiting on you before this runs", including when
no feature spec exists yet — the short-circuit for an empty `kb/features/` would
otherwise swallow them, which is the same absent-input trap recorded three times
above. `gapSummary` carries them as `needsReview` for `--json`.

Deleting the line is the act of confirming, so the answer lives in the file
under review rather than in whoever read the terminal that day. It blocks
nothing: a wrong guess and an unreviewed guess look identical to a checker, and
refusing to run on that basis would train people to delete the line unread.

Tests: 1137 across 76 files (+6).

### B2.5.6 — `Element.inDialog`, approved (2026-08-18)

The Bubblegum dialect writes a step as a sentence, not a selector. The open
question was how Flint would say *which* Save button when a page has two.

Answered by the operator, and the answer is narrower than the proposal: on an
ordinary page no qualifier is needed — `act(page, 'click the Save button')` is
the whole step. Only a dialog needs saying, because a dialog is when the same
label genuinely exists twice.

So `Element` gains **`inDialog?: boolean`** and nothing else. The `section`
half of the proposal is rejected: a qualifier derived from the nearest heading
is a guess about document structure, and inside a generated English sentence a
guess reads exactly like a fact.

Populated in the extractor's existing single `evaluate`, from
`closest('dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]')`
— `aria-modal` covers the div-with-a-role pattern most component libraries emit.
Written as `true` or omitted, never `false`, so the model does not grow for the
overwhelming majority of elements that are not in a dialog. It is deliberately
*not* part of `elementId`'s basis: the id is derived from identifying facts, and
folding in a state-dependent one would renumber elements between crawls.

Why `provenance` could not answer it: `provenance.revealed` says an element
appeared after a click, which is equally true of a dropdown item, and a dialog
open on page load carries no provenance at all.

This unblocks B3.

Note on running the browser suite in a container: this environment ships
Chromium build 1194 under `/opt/pw-browsers` while Playwright 1.62 asks for
1234, so `src/explorer/*` fails on launch unless the expected paths are shimmed.
Both new dialog tests were verified against a real browser that way, not
asserted from a fake.

### B2.5.7 — First run with a Screen Model, and the credential scan is empty (2026-08-18)

Explore finally ran against CCSIT (Keycloak login via `loginScript`, 2 pages,
33 elements, 31 verified unique, 100% resolve rate on `--validate`). The draft
that followed is the best one yet and exposed two things.

**What the Screen Model bought.** 12,847 in / 4,054 out, against 18,532 / 7,188
for the same card without it — roughly 40% cheaper, because the model stopped
hedging about which screens exist. `entities: 0` and `unresolved: 0`: no phantom
entities, no TODO states nobody can close. The "who is logged in is a role"
rule from B2.5.4 did what it was meant to.

**`manifest.credentials` is empty, and has been all along.** `jq '.credentials |
length'` returns 0, and all four role gaps in `flint kb` are downstream of it.

Worth recording how this hid for so long: an earlier draft's `openQuestions`
named `getBAPActivityVendorAdminUserCredentials` and
`getActivityVendorAdminCredentials`, and I read that as evidence the scan had
found them. It was the opposite. With `credentials` empty, `describeSuite`
omits the "Credential getters" section entirely, so the model had nothing to
choose between and invented two plausible names. **A confident-looking model
output was mistaken for a working deterministic stage** — the same failure
shape as "an absent input produces a well-formed empty result", one level up.

Third detection signal added: the declared return type. The suite's own login
flow is typed `(engine, page, credentials: LoginCredentials)`, so the project
has already named the concept, and `/credential/i` against `fn.returns` finds
every function that produces one regardless of naming convention. Deliberately
does not require the `get` prefix, and deliberately looks at the return type
only — `loginFlow(...): Promise<void>` *consumes* credentials, it does not
produce them.

Whether that is the whole fix is not yet known: `readCredentials` only sees
`suiteDir` plus `--root` directories, so the getters may simply never have been
scanned. Waiting on the operator's `--root` output before concluding.

**Stale drafts inflate the gap report.** `flint kb` reported 3 features, two of
which — `vendor-admin-facilitator-view` and `vendor-admin-facilitators-view` —
are the same card drafted twice. The never-overwrite rule compares paths, and
one letter of difference in the id means a second file rather than a `.draft.md`
divert. 8 of the 11 gaps came from the previous run's files. Not fixed yet; the
right answer is probably to match on the `Drafted by flint draft from <source>`
marker rather than the path, but that deserves its own change.

**Prompt v6.** The one genuine ungrounded need was "at least one vendor
facilitator record exists in the system" against an existing state named
`listed-under-company`. B2.5.4 taught the model to write the need and the state
in the same words — but only when it is proposing both. When the entity already
exists, the name is not the model's to choose. The prompt now says so, with
this exact pair as the worked example.

Tests: 1142 across 76 files (+3).

### B2.5.8 — `--root` was the whole story, and it was a flag nobody could see (2026-08-18)

The empty credential list from B2.5.7 was not a detection failure:

```
pnpm cli manifest --root packages/utilities --root packages/data --json
  -> { "creds": 25, "repos": 24 }
```

25 getters, found by the existing `get…Credentials` convention. The return-type
signal added in B2.5.7 was not what fixed it — it is a reasonable belt-and-braces
addition and it should stay, but the honest account is that `readCredentials`
only ever looked at `suiteDir` plus `--root`, and the getters live in
`packages/data`. Every earlier run had simply never been told where to look.

That is the bug worth fixing, and it is a design bug rather than a scanning one.
`--root` had to be retyped on every invocation, and the run that omits it does
not fail. It writes a smaller manifest, prints a cheerful summary, and the only
evidence is a count nobody remembers from yesterday. Downstream the damage is
total and silent: with `credentials` empty, `describeSuite` omits the section
entirely, so the model invents getter names that look exactly like real ones —
which is how this survived four drafts.

Two changes:

- **The manifest remembers its roots.** `SuiteManifest` gains
  `roots: string[]`, populated by the scan and reused by `flint manifest` when
  `--root` is absent; passing the flag replaces them. `--root` becomes a
  one-time setup step. The summary says which roots were used and whether they
  were remembered, so the reused case is visible rather than magic.
- **A narrower scan says so.** `shrinkage()` compares the new manifest against
  the one already on disk and names every category that went down, with both
  numbers: `credentials 25 -> 0`. Not an error — a suite really can shrink — but
  it is the only cheap place to notice, and "nothing downstream will complain"
  is stated outright in the message, because that is precisely what happened
  here.

The general lesson, which this project keeps re-learning in new costumes: **a
stage that silently degrades is worse than one that fails.** B2.5.4 was the same
shape (a draft that grounds nothing still writes four plausible files), and so
was the "absent input produces a well-formed empty result" note three entries
above. The fix is always the same — make the degraded case visibly different
from the healthy one at the moment it happens.

Tests: 1149 across 77 files (+7), including a read of a manifest written
before `roots` existed — every project with one on disk has that shape, and it
has to read as "no roots recorded" rather than failing on the first command
after an upgrade.

### B2.5.9 — 6 grounded, and three defects the good run exposed (2026-08-18)

First run with everything present: Screen Model, 25 credential getters, 24
repositories. **6 grounded, 3 gaps**, roles resolving to real getters
(`role.vendorAdmin via getBAPActivityVendorAdminUserCredentials`), and the
`review:` marker doing its job. The `vendor-facilitator` gap is correct and is
the answer, not a failure: no repository method creates facilitators, so the
state is honestly unreachable and the report says which specs depend on it.

Three defects, two of them mine.

**1. A `.draft.md` was being read as a live spec.** It carries the same `id` as
the file it sits beside, so `flint kb` reported one feature twice under the same
heading with different `dataNeeds`. The divert exists so a human can diff; a
draft awaiting review is not a spec, and `discoverFeatureFiles` now skips it
alongside the `_`-prefixed convention.

**2. One card, three specs.** `vendor-admin-facilitator-view`,
`vendor-admin-facilitators-view` and `vendor-admin-view-facilitators` sat side
by side, because the never-overwrite rule compares paths and a model asked twice
about one card does not produce the same id twice. Nothing failed and no file
was damaged — the gap report simply tripled. `priorDraftsFrom()` finds earlier
attempts by the `Drafted by flint draft from <source>` comment and names them in
the summary, saying plainly that `flint kb` will read them all.

**3. The prose-hint bug again, at the call site I did not fix.** B2.5.4 stopped
`near` being handed a sentence for setup hints. `renderRoles` was still doing
it, and a seventeen-word `credentialsHint` produced five candidates including
`getBAPRewardPartnerManagerCredentials`. `credentialQuery()` now uses the hint
only when it reads like a name and otherwise falls back to the shortest alias,
then the camelCase id — which tokenises to exactly the words that matter. The
prompt says two to four words and puts the qualifications in `description`,
which is not matched. **Fixing a bug at one call site is not fixing the bug.**

**And a process failure worth recording.** `pnpm typecheck` has existed since
Phase 0 and I had not been running it — `pnpm build` uses `tsconfig.build.json`,
which excludes tests, so `c6dc073` was pushed with two type errors in test
fixtures after I called it clean. Three older errors were sitting there too
(`plan-cache.test.ts` importing `FeatureSpec` from the wrong module and stamping
`generatedAt` on a `ScreenModel`; `pr/body.test.ts` using a `failureClass` value
that is not in the enum). All five fixed; `tsc -p tsconfig.json --noEmit` is
clean. Verification from here is build + **typecheck** + lint + test, not the
first, third and fourth.

Cost note: 19,919 in / 5,056 out, up from 12,847 / 4,054. Expected — the suite
listing now carries 25 credentials and 24 repositories with their methods, and
the existing-KB section is no longer empty. Worth watching, not worth acting on.
