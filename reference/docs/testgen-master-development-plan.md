# TestGen — Master Development Plan v1.0

**AI-powered test automation code generator for web applications**
Output: TypeScript + Playwright suites | Standalone tool | Evolution path: Pipeline → Hybrid → Full Agentic

> **Handover note for Claude Code:** This document is the single source of truth. Build in the phase order given. Each phase has locked decisions, deliverables, and exit criteria. Do not modify completed phase files in later phases unless the phase explicitly says so. When a decision is marked LOCKED, do not revisit it. When marked PROPOSED, use it as default but flag concerns.

---

## PART A — VISION & PRODUCT DEFINITION

## A1. What we are building

TestGen generates production-quality Playwright TypeScript automation suites for any web application, from three inputs:

1. **Knowledge base** — app context, feature specs, suite conventions (markdown files)
2. **Live application evidence** — a machine-built "Screen Model" of real pages and elements (no guessed selectors, ever)
3. **Existing suite state** — a "Suite Index" so new tests extend, reuse, and never duplicate

The generated suite is plain Playwright TS (Page Object Model) that runs with `npx playwright test` and has **zero runtime dependency on TestGen**.

## A2. Evolution roadmap (three horizons)

| Horizon | Name | What it is | AI role |
| --- | --- | --- | --- |
| **V1** | Pipeline CLI | Fixed 5-stage pipeline: Explore → Index → Plan → Generate → Verify | LLM called at fixed points with structured I/O |
| **V2** | Hybrid | Same pipeline skeleton; two stages upgraded with agentic loops (Explorer + Repair) | Agent loops inside bounded stages |
| **V3** | Full Agentic | Claude Agent SDK orchestrator with tools, memory, and self-improvement; pipeline stages become tools the agent uses | Agent owns the workflow end to end, humans approve |

**Rule: the pipeline is the skeleton forever.** V2/V3 never throw away V1 — they wrap it. Every V1 stage is built as an independently callable module with typed inputs/outputs precisely so it can later be exposed as an agent tool.

## A3. Core principles (LOCKED)

1. **Ground before you generate** — every selector in generated code must trace to Screen Model evidence. The LLM may never invent a selector.
2. **Plan before code** — a human-reviewable JSON test plan is produced before any TypeScript is written.
3. **Structured I/O everywhere** — all LLM inputs/outputs are zod-validated JSON except final code bodies.
4. **Zero runtime dependency in output** — generated suites are plain Playwright TS. (Optional Bubblegum output dialect changes this deliberately — see D3.)
5. **Never destroy human work** — managed-file markers; hand-edited files are diffed, never overwritten.
6. **Fail loudly, cap loops** — repair iterations capped; unresolved tests become `test.fixme()` with an explanatory comment, never silently dropped.
7. **Deterministic where possible, AI where needed** — selector ranking, suite indexing, failure classification are deterministic code, not LLM calls.

---

## PART B — ARCHITECTURE

## B1. Tech stack (LOCKED)

- TypeScript 5.x strict, Node 20+, ESM
- pnpm workspace (monorepo-ready but single package for V1)
- CLI: `commander`; config + all schemas: `zod`
- Playwright (`@playwright/test`) for both the Explorer and running generated suites
- LLM: Anthropic SDK primary; thin `LLMProvider` interface (complete, chat, structured) so OpenAI can slot in later. Model per role from config: `models.planner` (stronger), `models.coder` (cheaper), `models.repair` (stronger)
- Storage: plain JSON files under `.testgen/` (no DB in V1); everything versioned & diffable in git
- Logging: `pino`, with a `--verbose` flag; every LLM call logged with tokens in/out, latency, stage, purpose (never raw prompts unless `debug.logPrompts: true`)

## B2. Repository structure

```
testgen/
├── src/
│   ├── cli/                    # command definitions (init, explore, index, plan, generate, verify, run, ci)
│   ├── config/                 # config load + zod schema (testgen.config.ts in target project)
│   ├── schemas/                # ALL shared zod schemas (Phase 0, then locked)
│   │   ├── screen-model.ts
│   │   ├── suite-index.ts
│   │   ├── test-plan.ts
│   │   ├── run-report.ts
│   │   └── kb.ts               # feature-spec frontmatter schema
│   ├── explorer/
│   │   ├── crawler.ts          # BFS page queue
│   │   ├── auth.ts             # storageState bootstrap
│   │   ├── extractor.ts        # element extraction per page
│   │   ├── selector-ranker.ts  # deterministic stable-selector ranking
│   │   ├── flows.ts            # flow-script replay for hard-to-reach states
│   │   └── screen-model.ts     # writer, differ, replay-validator
│   ├── indexer/                # Suite Index builder (ts-morph static scan)
│   ├── context/                # Context Builder: prompt assembly + token budgeting
│   ├── generator/
│   │   ├── planner.ts          # Stage A: spec → TestPlan JSON
│   │   ├── emitter.ts          # Stage B: TestPlan → code files
│   │   ├── dialects/           # output dialects: playwright-pom.ts, bubblegum.ts
│   │   └── prompts/            # versioned prompt templates (md files)
│   ├── verifier/
│   │   ├── runner.ts           # runs suite, parses Playwright JSON reporter
│   │   ├── classifier.ts       # deterministic failure classification
│   │   └── repair.ts           # capped repair loop
│   ├── integrator/             # idempotent writer, managed markers, diff preview, PR mode
│   ├── llm/                    # provider interface + Anthropic impl + call logger
│   └── shared/                 # fs utils, hashing, token counting
├── templates/                  # scaffolds: playwright.config.ts, fixtures, tsconfig, kb starter files
├── benchmarks/                 # golden feature specs + demo-app configs + metrics runner
└── tests/                      # vitest unit + integration tests for TestGen itself
```

Target project layout (created by `testgen init`):

```
<user-project>/
├── testgen.config.ts
├── kb/
│   ├── app/                    # overview.md, roles.md, environments.md, flows/*.md
│   ├── features/*.md           # feature specs (frontmatter + body) — generation triggers
│   ├── conventions.md
│   └── dialects/               # optional: bubblegum.md
├── e2e/                        # generated suite (pages/ fixtures/ tests/ data/)
└── .testgen/
    ├── screen-model/           # model.json + per-run snapshots + diffs
    ├── suite-index/index.json
    ├── plans/<feature>.plan.json
    └── reports/<run-id>.json
```

## B3. The five pipeline stages

```
explore ──► index ──► plan ──► generate ──► verify
   │          │         │          │           │
Screen     Suite     TestPlan   TS files   RunReport
Model      Index     (JSON)     (e2e/)     + repair
```

Each stage: pure module, typed input/output, callable via CLI independently, and re-runnable (idempotent). `testgen ci` chains all five.

## B4. Key schemas (Phase 0 contracts — LOCKED once written)

**ScreenModel** (abridged):
```ts
Page { id, url, urlPattern, title, screenshotPath, reachedVia: FlowRef|LinkRef,
       elements: Element[], navTargets: string[] , capturedAt, appVersionHint? }
Element { id, role, name, testId?, domId?, text?, tagName, boundingBox,
          states: { visible, enabled }, selectorCandidates: SelectorCandidate[] }
SelectorCandidate { strategy: 'testid'|'role'|'label'|'placeholder'|'text'|'css',
                    value, score, unique: boolean, verified: boolean }
```

**TestPlan** (abridged):
```ts
TestPlan { featureId, generatedAt, screenModelVersion, cases: TestCase[] }
TestCase { id, title, priority: 'p0'|'p1'|'p2', tags: string[],
           status: 'new'|'skipped-duplicate'|'update-existing',
           duplicateOf?: string,            // suite-index test id when skipped
           steps: PlanStep[], }
PlanStep { action: 'goto'|'click'|'fill'|'select'|'assert'|'custom',
           elementRef?: string,             // MUST be an Element.id from ScreenModel
           value?: string, assertion?: { kind, expected },
           note?: string }
```

**SuiteIndex**: pageObjects (class, file, methods, selectors used), specs (file, test titles, tags), fixtures, dataFactories, coverageMap (featureId → test ids), managedFiles vs handEditedFiles.

**RunReport**: per-test { title, file, status, failureClass?: 'selector-not-found'|'timeout'|'assertion-mismatch'|'navigation'|'env'|'unknown', errorExcerpt, repairAttempts }.

**Selector ranking rules (deterministic, LOCKED):** testid (100) > role+accessible-name if unique (85) > label (75) > placeholder (65) > exact text if unique (55) > scoped css (30). Uniqueness verified live during exploration (`locator.count() === 1`). Non-unique candidates get score × 0.3 and `unique:false`. Emitter must pick the highest-scored verified candidate and record strategy used as a code comment.

## B5. Output dialects (D3)

Dialect = code-emission style guide loaded into Stage B. V1 ships `playwright-pom` (default). `bubblegum` dialect (emits `act()/verify()/extract()` intent calls via `@bubblegum-ai/node`, minimal locators) is a Phase 6 stretch goal — the dialect interface must exist from Phase 3 so adding it is config-only.

---

## PART C — V1 DEVELOPMENT PHASES

### Phase 0 — Foundation (1 wk)

**Build:** repo scaffold, strict TS config, CLI skeleton with all command stubs, config schema + loader, ALL zod schemas from B4, LLMProvider interface + Anthropic implementation + call logger, prompt template loader (md files with `{{placeholders}}`), `testgen init` (scaffolds kb/, config, e2e skeleton from templates).
**Expect at exit:** `testgen init` produces a valid project; `testgen --help` lists all commands; schemas have unit tests incl. rejection cases; a `hello-llm` smoke command proves provider wiring.
**Scenarios to handle:** missing/invalid config (clear zod error messages, not stack traces); no API key (actionable error naming the env var); re-running init on existing project (prompt, never clobber).

### Phase 1 — Explorer (2 wks)

**Build:** auth bootstrap (three modes: `storageStatePath`, `loginScript` (user-provided TS function), `credentials` + login-flow replay); BFS crawler with same-origin + include/exclude URL patterns, `maxPages`, `maxDepth`; per-page extractor (aria snapshot + interactive element enumeration + selector candidates + live uniqueness verification + screenshot); flow-script replay (`kb/app/flows/*.md` with embedded code blocks) for hard-to-reach states; Screen Model writer + differ (`testgen explore --diff` reports added/removed/changed pages+elements between runs); replay-validator (`testgen explore --validate` re-resolves every stored top candidate, reports break rate).
**Expect at exit:** full Screen Model for 2 demo apps (saucedemo.com + one SPA, e.g. a RealWorld/Conduit deployment); ≥95% of stored top-candidate selectors re-resolve on immediate validation run; crawl of 30 pages completes < 5 min.
**Scenarios to handle (design for ALL of these):**
- SPAs with client-side routing (URL changes without navigation events — hook `page.on('framenavigated')` + history API; wait strategy: network idle + DOM stable heuristic, configurable per app)
- Login walls mid-crawl (session expiry → re-auth once, then continue; if re-auth fails, abort with partial model saved + clear report)
- Infinite/parameterised URLs (`/order/123`, `/order/124` → collapse via `urlPattern` normalization rules in config, e.g. `/order/:id`; store one representative page)
- Dynamic content: modals/menus that require interaction to exist (two-pass extraction: snapshot page, then for elements with `aria-haspopup`/menu roles, open-snapshot-close; keep it bounded — one interaction depth in V1)
- iframes (extract same-origin frames into the page's element list with framePath recorded; skip cross-origin, log them)
- Shadow DOM (Playwright locators pierce open shadow roots — verify extractor uses locator APIs, not raw DOM walks; closed shadow roots: log as unreachable)
- i18n apps (record `lang` per page; selector ranking demotes text-based strategies when config `i18n: true`)
- Destructive links (crawler must never click — it navigates via `goto` on hrefs only; buttons are catalogued, not pressed, except in flow scripts and the bounded modal pass with a config `dangerousActionPatterns` denylist: logout, delete, submit, pay)
- CAPTCHAs / bot detection (detect via config patterns; mark page unreachable, continue; document that target envs should disable CAPTCHA for test users)
- Auth'd multi-role apps (Screen Model per role when `roles[]` configured; pages tagged with role)

### Phase 2 — Suite Indexer (1 wk)

**Build:** ts-morph static scan of `e2e/`: page-object classes/methods, spec files/test titles/tags, fixtures, data factories; coverage map from `@feature:<id>` tags + plan history; managed-file detection via `/* @testgen:managed <hash> */` header (hash of generated content → hand-edit detection by hash mismatch); `testgen index` command + JSON output.
**Expect at exit:** index of a 50-file suite < 10 s; correctly distinguishes generated vs hand-written vs hand-edited files; empty-suite and no-suite cases produce valid empty index.
**Scenarios:** suites not following our conventions (best-effort extraction: any exported class in `pages/` = page object; any `test(` title = test); TS parse errors in user files (skip file, warn, continue); monorepos (index only the configured suite dir).

### Phase 3 — Planner (Stage A) (1.5 wks)

**Build:** Context Builder (feature spec + relevant Screen Model pages matched via frontmatter `pages:`/`flows:` hints + fallback URL/keyword matching + conventions + Suite Index summary + 1–2 exemplar files; hard token budget with priority-based truncation: spec > relevant pages > index > exemplars); Stage A prompt (versioned template); TestPlan generation with zod validation + one retry on invalid JSON; duplicate detection (planner must consult coverage map; deterministic post-check: title similarity + same feature tag → force `skipped-duplicate`); plan renderer (`<feature>.plan.md` human-readable view); `testgen plan <feature>` with `--review` flag that opens rendered plan.
**Expect at exit:** for 5 golden feature specs, plans reference only real Element ids (validator enforces — any unknown elementRef fails the plan), cover every acceptance criterion in the spec (checklist cross-reference rendered in plan.md), and correctly skip cases already covered in a pre-seeded suite.
**Scenarios:** feature spec references UI that doesn't exist in Screen Model (plan emits `blocked` case with reason "element not found in exploration — re-explore or add flow script", never invents); vague specs (planner asks: plan.md includes an `openQuestions` section instead of guessing on p0 cases); spec covering multiple pages/flows; negative cases and edge cases explicitly required when spec lists them; data prerequisites (plan declares `dataNeeds` so humans see required test data).

### Phase 4 — Emitter (Stage B) (1.5 wks)

**Build:** dialect interface + `playwright-pom` dialect; POM emitter (one class per Screen Model page used, selectors from top-ranked candidates only, methods derived from plan steps); fixture emitter (auth via storageState fixture; data factory stubs from `dataNeeds`); spec emitter (describe per feature, test per plan case, tags incl. `@testgen @feature:<id>`); reuse enforcement (if Suite Index has `LoginPage`, extend it via new methods in a partial-class-safe way: emit additions with managed markers into `login.page.testgen.ts` companion or in-place if the file is fully managed); `tsc --noEmit` + eslint gate before writing to suite; `testgen generate <feature> [--dry-run]` with diff preview.
**Expect at exit:** generated suite for golden specs compiles + lints clean 100%; ≥70% first-run pass rate on demo apps; regenerating the same feature is byte-identical (determinism check: temperature 0 for Stage B, stable ordering everywhere); no duplicate page objects across two features touching the same page.
**Scenarios:** two features generated concurrently touching same page object (file-level lock + merge additions); plan case `update-existing` (emit into the existing spec file if managed; if hand-edited, emit sibling file + report); selector candidate non-unique (emitter must fall to next verified candidate; if none verified unique, emit `test.fixme()` with reason); assertion kinds: visibility, text, URL, count, input value, toast/alert presence.

### Phase 5 — Verifier + Repair (1.5 wks)

**Build:** runner (spawns `npx playwright test --reporter=json` scoped to generated tags/files, env from config); failure classifier (deterministic: match Playwright error shapes → failureClass; attach trace/screenshot paths); repair loop (per failing test: structured failure context — failureClass, error excerpt, plan step, current code, relevant Screen Model elements — → repair prompt → patched code → re-run just that test; max 2 iterations LOCKED; selector-not-found failures first retry deterministically with next selector candidate BEFORE any LLM call); fixme fallback with comment block (failureClass + last error + repair history); RunReport writer; `testgen verify [--repair]`.
**Expect at exit:** post-repair pass rate ≥90% on golden set; env failures (app down, bad base URL) detected pre-run via health check and reported as env, never "repaired"; zero infinite loops (hard iteration cap + per-test wall-clock timeout); flaky detection (pass-on-retry without code change → marked `flaky`, not repaired).
**Scenarios:** app genuinely broken (real bug!) — assertion-mismatch failures that survive repair are surfaced as "possible application defect" in the report, distinct from test defects (this is a feature: TestGen finding real bugs); test data collisions between parallel tests (report recommends serial mode or data factory uniqueness — factories emit unique suffixes by default); auth expiry mid-run.

### Phase 6 — Integration, CI & Polish (1.5 wks)

**Build:** `testgen ci` (chained pipeline, headless, exits non-zero on failures, machine-readable summary); drift mode (`testgen explore --diff` → map changed elements to affected tests via Suite Index selector usage → report "these 7 tests likely break" → optional targeted regeneration of page objects only); GitHub PR mode (branch, commit, PR body = rendered plan + run report; `gh` CLI or octokit); docs (README, KB authoring guide, config reference); benchmark runner (metrics: compile rate, first-run pass, post-repair pass, selector re-resolve rate, tokens + est. cost per feature, wall time per stage) with baseline recorded; **stretch:** `bubblegum` dialect.
**Expect at exit:** end-to-end: drop new feature spec → `testgen ci` → PR with passing tests, no human touch in between; benchmark baseline documented; a stranger can onboard from README alone.

**V1 total: ~10 weeks part-time.** Demoable after Phase 4.

---

## PART D — V2: HYBRID (AGENTIC STAGES)

Prereq: V1 benchmark baseline exists (so agentic upgrades must PROVE improvement, not vibe it).

### D1. Agentic Explorer (the big win)

Replace/augment the BFS crawler with a goal-driven exploration agent for apps the dumb crawler handles poorly (heavy SPAs, wizard flows, state-dependent screens).
- Loop: LLM sees current page (aria snapshot + screenshot), decides next action (navigate/click/fill with safe values/open menu), observes, updates a mental map, continues until coverage goal or budget met
- Tools: `goto`, `click(elementRef)`, `fill(elementRef, value)`, `snapshot()`, `registerPage()`, `markUnreachable(reason)`
- **Same output contract: Screen Model JSON.** Downstream stages don't know or care which explorer ran.
- Safety rails carried over: dangerousActionPatterns denylist, budget caps (max actions, max tokens, max minutes), same-origin lock, never on production envs (config `envClass: 'test'` required)
- Config: `explorer.mode: 'crawl' | 'agent' | 'crawl-then-agent'` (default: crawl-then-agent — cheap BFS first, agent only for pages/flows the crawl flagged unreachable)

### D2. Agentic Repair

Replace single-shot repair prompt with a bounded debugging agent for tests that survive V1 repair: tools = read file, edit file, run single test, view trace/screenshot, query Screen Model. Budget: max 8 tool calls per test. Exit: pass, or fixme with a *diagnosis* (better than V1's error dump). Measure: repair success rate uplift vs tokens spent.

### D3. Plan-review agent (optional)

A critic pass between Stage A and B: adversarially reviews plans for weak assertions, missing negative cases, unrealistic data. Cheap, high leverage. Human review stays for p0 features.

**V2 exit criteria:** agentic explorer lifts page/element coverage ≥20% on SPA benchmark app; agentic repair lifts post-repair pass rate to ≥95%; cost per feature stays under 2× V1 baseline.

---

## PART E — V3: FULL AGENTIC SETUP

The end state: a QA engineering agent built on **Claude Agent SDK** (TS-native, pre-built loop, tool ecosystem — LOCKED choice over LangGraph for stack-fit reasons; revisit only if a Python service emerges).

### E1. Architecture

- **Orchestrator agent** with the five V1 stages exposed as tools (`explore`, `index`, `plan`, `generate`, `verify`) plus granular tools from V2 (browser control, file edit, single-test run)
- Given goals, not commands: "Ensure the checkout feature has full coverage including negative cases" — the agent decides the sequence: check index → notice stale Screen Model → re-explore checkout pages only → plan delta → generate → verify → open PR
- **Human approval gates (LOCKED):** PR review always; plan approval for p0 features; any run against a non-test envClass is refused
- **Memory layer:** persistent project memory (JSON/SQLite under `.testgen/memory/`): which selector strategies survive longest in THIS app, which flows are flaky, past repair diagnoses, per-page quirks ("date picker needs keyboard input"). Injected into relevant prompts. This is how the system improves with time.
- **Triggers:** CLI ("do X"), CI schedule (nightly: drift check → auto-repair page objects → PR), webhook (new feature spec merged → generate), test-failure listener (CI red → diagnose → propose fix PR)

### E2. Continuous improvement loop

1. Every run appends to benchmark history (pass rates, cost, drift survival)
2. Weekly auto-report: selector-strategy survival stats → feeds selector-ranker weights per app
3. Repair diagnoses accumulate → planner prompt gains app-specific "known pitfalls" section
4. Prompt templates versioned; A/B harness in benchmarks/ to promote a prompt only when metrics improve
5. Eventually: fine-tuning dataset export (plan → accepted-code pairs) if volume justifies

### E3. What "best possible automation code" means (the north-star rubric)

Generated suites are judged on: correctness (pass + actually assert the acceptance criteria), stability (survive UI drift, no flake), readability (a human QA would sign off in review), maintainability (POM discipline, reuse, naming), coverage (incl. negative/edge cases), and cost (tokens + minutes per feature). The benchmark runner scores all six from V1 onward — V3's agent optimizes against this rubric, not against "tests pass".

---

## PART F — RISK REGISTER (ALL VERSIONS)

| Risk | Phase | Mitigation |
| --- | --- | --- |
| Crawler blocked (CAPTCHA, WAF, bot detection) | 1 | Detection patterns, unreachable marking, doc: whitelist test agents |
| Selector rot between explore and generate | 1/4 | Screen Model versioned; emitter warns if model > N days old; `--validate` replay |
| LLM invents element refs | 3 | Hard zod + referential validation; plan fails, never passes through |
| Token cost blowup on large apps | 3 | Per-feature page scoping, token budgeter, cheap model for Stage B |
| Overwriting human edits | 4 | Managed markers + hash; hand-edited → sibling file + report |
| Infinite repair loops | 5 | Hard caps (2 iterations V1 / 8 tool calls V2), wall-clock timeouts |
| "Repairing" real app bugs into green tests | 5 | Assertion-mismatch surviving repair = flagged possible defect, never weakened assertions (repair prompt forbidden from changing expected values without plan change) |
| Agent takes destructive actions | D1/E1 | Denylist, envClass guard, budget caps, same-origin lock |
| Non-determinism creep in V2/V3 | D/E | Pipeline skeleton retained; benchmark gate: agentic mode must beat baseline to be default |
| Secrets leakage into prompts/artifacts | all | Redaction pass on context builder (password/token field values), no raw prompt logging by default |

---

## PART G — IMPLEMENTATION ORDER FOR CLAUDE CODE

1. Phase 0 in full (schemas are the contract — get sign-off before Phase 1)
2. Phases 1 → 5 strictly in order; each phase ends with: unit tests green, the phase's CLI command working against demo app, a short PHASE_NOTES.md recording deviations
3. Phase 6, then benchmark baseline commit
4. STOP. V2/V3 are separate kickoffs with their own prompts — do not pre-build agentic scaffolding into V1 beyond the module/tool-shaped boundaries already specified
5. Testing discipline: vitest for units; integration tests hit saucedemo.com (stable public target); no test may call the real LLM — provider gets a deterministic fake with recorded fixtures
6. Anything ambiguous: prefer the simpler deterministic option and record the question in PHASE_NOTES.md

— End of master plan —
