# CLAUDE.md — TestGen Project Rules

You are building **TestGen**, an AI-powered test automation code generator for web applications (TypeScript + Playwright output). The complete specification lives in `docs/testgen-master-development-plan.md`. That document is the **single source of truth** — read it before any work.

## Non-negotiable working rules

1. **Build phases strictly in order** (Phase 0 → 6, Part C of the master plan). Never start a phase before the previous phase's exit criteria are met and verified.
2. **Completed phase files are frozen.** Later phases only add new files or extend explicitly designated wiring points. If a change to a frozen file seems necessary, STOP and record the question in `PHASE_NOTES.md` instead of making the change.
3. **Decisions marked LOCKED in the master plan are not revisited.** Decisions marked PROPOSED are defaults — use them, flag concerns in `PHASE_NOTES.md`.
4. **Schemas are the contract.** All shared zod schemas live in `src/schemas/` and are written in Phase 0, then locked. Any schema change after Phase 0 requires explicit human approval.
5. **Every phase ends with proof:** unit tests green (`pnpm test`), the phase's CLI command working against the demo app, and a `PHASE_NOTES.md` entry (deviations, open questions, verified test count).
6. **No real LLM calls in tests.** The `LLMProvider` interface gets a deterministic fake with recorded fixtures for all testing.
7. **Ambiguity rule:** prefer the simpler deterministic option, record the question in `PHASE_NOTES.md`, continue.

## Stack (locked)

TypeScript 5.x strict • Node 20+ • ESM • pnpm • commander (CLI) • zod (all schemas/config) • @playwright/test • Anthropic SDK behind `LLMProvider` interface • pino logging • vitest • JSON file storage under `.testgen/` (no DB)

## Code conventions

- Strict TS, no `any` without a `// why:` comment
- Every module: typed input/output, independently callable (V2/V3 will expose stages as agent tools — module boundaries matter)
- Errors: custom error classes with actionable messages (name the config key or env var to fix); never raw stack traces to CLI users
- LLM calls: always through `LLMProvider`, always logged (stage, purpose, tokens in/out, latency), never log raw prompts unless `debug.logPrompts: true`
- Prompt templates: versioned markdown files in `src/generator/prompts/`, loaded by the template loader — never inline prompt strings in code
- Determinism: temperature 0 for code emission; stable sort ordering everywhere; regenerating identical input must produce byte-identical output

## Testing discipline

- vitest unit tests colocated per module; integration tests target https://www.saucedemo.com
- Schema tests must include rejection cases (invalid input → helpful error)
- The selector-ranker and failure-classifier are pure functions — table-driven tests required

## Definition of done (every phase)

- [ ] Exit criteria from master plan Part C verified and stated with numbers
- [ ] `pnpm test` green, `pnpm build` clean, `pnpm lint` clean
- [ ] Phase CLI command demonstrated against demo app
- [ ] PHASE_NOTES.md updated
- [ ] No frozen files modified
