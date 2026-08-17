# Bubblegum Dialect — Development Plan

Extends the master plan's Phase 6 stretch goal into its own phase sequence.
Same discipline as Part C: build **B1 → B4 in order**, each phase ends with
tests green, its CLI command demonstrated locally, and a `PHASE_NOTES.md` entry.

**Demo target:** https://www.saucedemo.com, built as a Bubblegum suite from
scratch — the greenfield case, which is also the harder one, because there is
nothing to reuse and every layer has to be generated.

---

## What is being reused, and what is new

The point of doing this inside Flint rather than as a separate tool is that
most of the pipeline does not care which dialect it emits.

| Stage                                        | Status                                                       |
| -------------------------------------------- | ------------------------------------------------------------ |
| Feature spec reading (`kb/features/*.md`)    | **Reused unchanged**                                         |
| Explorer / Screen Model                      | **Reused** — labels and roles instead of selector candidates |
| Plan cache                                   | **Reused unchanged**                                         |
| Planner (Stage A → TestPlan)                 | **Reused**, with manifest added to its context               |
| Duplicate detection, supersede, shrink guard | **Reused unchanged**                                         |
| Managed markers, divert, PR mode, drift      | **Reused unchanged**                                         |
| Suite Index (page objects)                   | Not used by this dialect                                     |
| Selector ranker                              | **Not used** — Bubblegum resolves elements at run time       |
| Emitter Stage B                              | **New** — flows/data/tests instead of page objects/specs     |
| Compile gate                                 | **Replaced** by `preflight()` grounding                      |

The two genuinely new things are the **manifest** (B1) and the **emitter with a
preflight gate** (B3). Everything else is wiring.

---

## The principle that carries over

Flint's core rule is _ground before you generate_: the model may never invent a
selector, and every `elementRef` in a plan is checked against the Screen Model
before code is written.

Bubblegum has no selectors, so the rule does not disappear — it **moves**. The
thing the model must not invent becomes the **flow**, and the evidence becomes
the manifest. Ask for a test that logs in and a model will happily call
`loginToPortal()` when the function is named `loginFlow()`; the result compiles,
imports nothing that exists, and fails at run time.

|                      | `playwright-pom`                        | `bubblegum`                        |
| -------------------- | --------------------------------------- | ---------------------------------- |
| Must not be invented | selectors                               | flow names, phrases                |
| Evidence             | Screen Model                            | manifest + Screen Model labels     |
| Referential check    | every `elementRef` is a real Element id | every `reuse` is a real export     |
| Gate before writing  | `tsc --noEmit`                          | `preflight()` against the live app |

---

## B1 — Suite Manifest ✅

**Built.** `flint manifest` scans a suite and inventories what it can already
do: flows (with JSDoc summaries, params, return types, and the `act`/`verify`
phrases they issue), data exports, helpers, credential getters and repositories.

**Derived, never authored.** The code is the truth; the manifest is an index of
it, regenerated on every run and rewritten after generation by re-scanning. A
hand-maintained inventory goes stale the first time somebody renames a function,
and a stale inventory is worse than none — the referential check would then
reject valid code and accept invented code.

Monorepo aware: `--root` adds directories outside the suite, because credential
getters and repositories usually live in sibling packages and the generator has
to name them exactly.

**Exit criteria — met:**

- Scans the four-layer pattern: `flows/`, `data/`, `helpers/`, `tests/`
- Resolves dynamic `await import(...)`, which is how the test template imports
- Survives syntax errors, missing directories and `node_modules`
- Deterministic: two scans of one tree agree
- Empty manifest is valid — the greenfield case is not an error

## B2 — Knowledge base + gap report

Feature specs carry what only a human knows: which role runs the test, what
setup the preconditions need, which repository cleans up.

`kb/app/glossary.md`, `kb/app/entities/*.md`, `kb/app/rules.md`.

The important half is the **gap report**: when the planner cannot ground
something, it says so by name rather than guessing —

```
✗ "GAQ status = unfit" — no setup path known.
  Add to kb/app/entities/gaq.md: how does a test reach this state?
```

The KB then grows from use rather than from discipline, which is the only way
these documents survive.

## B3 — Bubblegum emitter + preflight gate

The emitter: `TestPlan` → `<feature>.flow.ts`, `<feature>.data.ts`,
`<feature>.test.mts`, reusing every flow the plan referenced and writing only
what is new.

The gate: `preflight()` dry-runs every emitted phrase against the live app and
reports `{ok, confidence, resolver}` without executing. **This is not optional.**
A Bubblegum flow with a typo is valid TypeScript — `act(engine, 'Click the
Sumbit buton')` compiles perfectly — so without preflight there is no check at
all between generation and a failing run.

## B4 — `flint init --dialect bubblegum`

Scaffolds the four-layer structure, the shared helpers, both `bubblegum.yaml`
config modes (live and replay), `requirements.txt` for the Python engine, and
the `BUBBLEGUM_PYTHON` note — which the dialect pack calls the single most
common setup failure.

No new design standard is invented here. The four-layer pattern is already
proven in production; this codifies it.

---

## Open decisions

1. **`Element.section`** — Bubblegum disambiguates repeated labels in English
   (`"… in the Billing section"`, `"… in dialog"`). Our Element schema has
   neither. Schemas are LOCKED, so this needs explicit approval before B3.
2. **Seeding vs cleanup** — the manifest now reports repository methods, so
   pointing `flint manifest` at a real project answers whether preconditions
   are reachable at all.
