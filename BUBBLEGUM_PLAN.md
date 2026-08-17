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

## B2 — Knowledge base + gap report ✅

Feature specs carry what only a human knows: which role runs the test, what
setup the preconditions need, which repository cleans up.

`kb/app/glossary.md`, `kb/app/entities/*.md`, `kb/app/rules.md`.

The important half is the **gap report**: when the planner cannot ground
something, it says so by name rather than guessing —

```
✗ "GAQ status = unfit" — no setup path known.
  Add to kb/app/entities/gaq.md: how does a test reach this state?
```

**Built, and with no change to any LOCKED schema.** The feature-spec schema
already has `dataNeeds` — "declared data prerequisites" — which is exactly the
hook this needed. So the app knowledge lives in `kb/app/` and specs refer to it
in plain words:

```yaml
dataNeeds:
  - a user whose GAQ status is unfit
```

That is also the better design regardless of the schema question: "how does a
test reach GAQ-unfit" is a property of the application, not of one feature, and
a dozen specs will want it. Recording it per spec would copy the same answer
into a dozen files and guarantee they drift.

`flint kb` resolves each need against `kb/app/entities/*.md`, and every
`repository:` or `flow:` reference against the manifest. Deterministic, no model
call, so it can run before every `ci` without anyone weighing the cost.

The KB then grows from use rather than from discipline, which is the only way
these documents survive.

**Exit criteria — met:**

- Prose matching with aliases: "fitness status" finds `gaq`, "partial fit"
  finds `partial-fit`
- `repository:` and `flow:` checked against the manifest, with suggestions that
  survive the real mistake — right noun, wrong verb (`setGAQStatus` →
  `updateGAQ`)
- The whole KB is checked independently of any feature, so a reference broken by
  last week's rename is found now rather than by whichever spec is unlucky
- `unreachable:` is a first-class answer, reported with its recorded reason
- A missing or half-written KB produces a report, never an error

## B2.5 — `flint draft` ✅

**Built.** Reads a requirement document and writes the feature specs, entity
files and roles it implies.

Added because B2 shipped the half that *checks* a knowledge base and left a
human to write it — which meant hand-copying facts already sitting in the card
and the manifest. The operator was right to push back: the KB is intermediate
output, not a third input.

```
flint draft ./HPBPPH-17169.md --dir <project>
```

**The model proposes, Flint disposes.** A drafted state carries a free-text
`setupHint` — "set the user's GAQ status" — and Flint matches it against the
manifest. A hint that names a real method becomes `repository:`; one that does
not becomes a visible TODO with the model's own words and the closest
candidates. `UserRepository.setGAQStatus` looks exactly as convincing as the
method that exists, so a near miss must stay a near miss.

**Exit criteria — met:**

- Every spec is written `status: draft` regardless of what the model thought
- An existing file is never overwritten — the draft lands as `.draft.md` beside
  it, reported, for a human to diff
- Out-of-scope requirements are listed with reasons, not silently dropped
- An ambiguous role is flagged rather than chosen
- What B2.5 writes, B2 reads: a round-trip test asserts `readAppKnowledge`
  parses the output with no warnings

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
2. ~~**Seeding vs cleanup**~~ — **answered** by running against the real
   project. Of 215 repository methods, 14 create rows and 29 update them.
   Critically `UserRepository.updateGAQ` exists, which is the precondition
   HPBPPH-17170 turns on. Time-shifting helpers are there too
   (`EventsRepository.backDateEventAndSession`,
   `updateRoadShowEventStartAndEndDate`, `updateSurveyStartTime`), which is what
   lifecycle ACs like "today's date > visibility period" need. The gap is
   activity *data*: `ActivityRepository` can `deleteMVPA` but cannot insert it,
   so "user has synced some MVPA progress" has no DB path.

   So B2's spec schema needs a `setup:` block that names repository methods,
   and the gap report has to distinguish "no setup path exists" from "a setup
   path exists but this spec did not name it".
