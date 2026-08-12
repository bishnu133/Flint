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
