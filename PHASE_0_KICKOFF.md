# Phase 0 Kickoff — Flint Foundation

Paste this as your first message to Claude Code (or run it as a command) after the repo is set up with CLAUDE.md and docs/flint-master-development-plan.md in place.

---

Read `CLAUDE.md` and `docs/flint-master-development-plan.md` fully before writing any code.

We are starting **Phase 0 — Foundation** of Flint. Scope is exactly Part C / Phase 0 of the master plan. Do not build anything from later phases.

## Deliverables for this session

1. **Repo scaffold**: pnpm project, TypeScript 5 strict, ESM, Node 20+, vitest, eslint + prettier, pino. Folder structure exactly as master plan section B2 (`src/cli`, `src/config`, `src/schemas`, `src/llm`, `src/shared`, `templates/`, `tests/` — create empty stage folders with `.gitkeep` for explorer/indexer/context/generator/verifier/integrator).
2. **All shared zod schemas** in `src/schemas/` per master plan section B4: `screen-model.ts`, `test-plan.ts`, `suite-index.ts`, `run-report.ts`, `kb.ts` (feature-spec frontmatter), plus `config.ts` (flint.config schema: baseUrl, envClass, auth modes, explorer options incl. urlPattern rules / maxPages / maxDepth / dangerousActionPatterns / i18n flag / roles, models per role, dialect, token budgets, debug flags). Every schema gets unit tests including at least 2 rejection cases with assertion on the error message quality.
3. **LLMProvider interface** (`complete`, `chat`, `structured<T>(schema, prompt)`) + Anthropic implementation + call logger + deterministic `FakeProvider` for tests with fixture recording/playback.
4. **Prompt template loader**: markdown files with `{{placeholder}}` substitution, template version header, missing-placeholder = hard error.
5. **CLI skeleton** (commander): `init`, `explore`, `index`, `plan`, `generate`, `verify`, `run`, `ci` — all registered with help text; only `init` and `hello-llm` implemented in this phase, the rest print "not yet implemented (Phase N)".
6. **`flint init`**: scaffolds target-project layout per B2 (flint.config.ts, kb/ starter files from templates/, e2e/ skeleton with playwright.config.ts + auth fixture stub + tsconfig). Re-running on an existing project must prompt and never clobber.
7. **`flint hello-llm`**: smoke command proving provider wiring (one tiny structured call, prints model + token counts).

## Exit criteria (verify and report each with evidence)

- `pnpm build`, `pnpm lint`, `pnpm test` all clean — state final test count
- `flint --help` lists all 8 commands
- `flint init` run in a temp dir produces a valid project; re-run prompts instead of overwriting
- `flint hello-llm` works with ANTHROPIC_API_KEY set, and fails with an actionable error naming the env var when unset
- Invalid flint.config.ts produces a friendly zod error naming the bad key, not a stack trace
- `PHASE_NOTES.md` created with: deviations (should be none), open questions, verified test count

## Hard constraints

- Schemas follow section B4 field-for-field. Where B4 is abridged ("..."), you may add obviously-needed fields — list every addition in PHASE_NOTES.md for review.
- The selector ranking rules (B4) are LOCKED constants — define them in `src/schemas/screen-model.ts` or `src/shared/` as exported config, with the exact scores given.
- No real network calls in tests. FakeProvider only.
- Stop at the end of Phase 0. Present the schema files for human review — Phase 1 does not start until schemas are approved.
