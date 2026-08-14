# Flint

Flint generates a TypeScript + Playwright end-to-end test suite for a web
application, by exploring the running app and reading a small knowledge base you
write about it.

It is not a recorder and not a "write my tests" prompt box. The pipeline is
deliberately boring in the places that matter: it explores with a real browser
and verifies every selector against the live DOM, it typechecks generated code
before writing a single file, and it runs the suite it produced and tells you
what actually passed.

---

## What you need

- **Node 20+** and **pnpm**
- A **test environment** of the app you want covered. Flint refuses to explore
  anything whose `envClass` is not `test` — exploration drives a real browser
  through real flows, and that is only ever acceptable on a disposable
  environment.
- An **`ANTHROPIC_API_KEY`** for the planning and repair stages. Everything
  else — exploration, code emission, the compile gate, running the suite — is
  deterministic and needs no model at all.

---

## Five minutes to a passing suite

```bash
# 1. Install Flint
git clone https://github.com/bishnu133/Flint && cd Flint
pnpm install && pnpm build

# 2. Scaffold a project (creates flint.config.ts, kb/, e2e/)
pnpm cli init --dir ~/my-app-tests
cd ~/my-app-tests && npm install && npx playwright install chromium
cd -   # every flint command runs from the Flint checkout

export ANTHROPIC_API_KEY=sk-ant-...
export DEMO=~/my-app-tests
```

Edit `$DEMO/flint.config.ts` — at minimum `baseUrl`, and `explorer.testIdAttribute`
if your app does not use `data-testid`. Then:

```bash
# 3. Explore the app (real browser, verifies every selector)
pnpm cli explore --dir $DEMO

# 4. Describe one feature in kb/features/<id>.md, then run the pipeline
pnpm cli ci --dir $DEMO
```

`ci` plans every feature, generates the suite, typechecks it, writes it, runs
it, and prints a pass rate. The generated tests land in `$DEMO/e2e/`.

> **Run commands from the Flint checkout, pointing at your project with
> `--dir`.** Running them from inside the project directory is the single most
> common setup mistake — Flint's own dependencies aren't there.

---

## The pipeline

```
kb/features/*.md ──┐
                   ├──▶ plan ──▶ generate ──▶ compile gate ──▶ write ──▶ verify ──▶ repair
flint explore ─────┘     (LLM)   (deterministic)   (tsc)                (playwright)  (LLM, last)
   │
   └─▶ .flint/screen-model/model.json
```

**Explore** drives a browser through the app and records a _Screen Model_: every
page, every interactive element, and a ranked list of selectors for each — each
one verified unique against the live DOM. Nothing downstream ever guesses a
selector.

**Plan** turns one feature spec plus the relevant slice of the Screen Model into
a `TestPlan`: test cases, steps, assertions, all referencing real element ids.
This is the one stage where a model decides _what to test_.

**Generate** turns the plan into page objects and specs. It is a deterministic
emitter, not a model — the same plan and model produce byte-identical files.

**The compile gate** typechecks the generated suite _before_ anything is
written. If it does not compile, nothing is written at all. A suite is never
left in a state Flint knows is broken.

**Verify** runs the suite with Playwright, classifies each failure, and — with
`--repair` — tries a deterministic selector retry first, then a model, and marks
what it cannot fix with a `fixme` explaining why.

---

## Commands

| Command                                   | What it does                                                        |
| ----------------------------------------- | ------------------------------------------------------------------- |
| `flint init`                              | Scaffold `flint.config.ts`, `kb/`, and an `e2e/` Playwright project |
| `flint explore`                           | Build the Screen Model from the live app                            |
| `flint explore --diff`                    | Re-crawl and report drift — **and which tests it breaks**           |
| `flint explore --diff --fix-page-objects` | Re-point page objects at a changed UI, specs untouched              |
| `flint explore --validate`                | Re-resolve every stored selector; fail below a threshold            |
| `flint index`                             | Scan an existing suite (page objects, specs, coverage)              |
| `flint plan <feature>`                    | Plan one feature                                                    |
| `flint generate <feature>`                | Generate one feature's code                                         |
| `flint verify [--repair]`                 | Run the suite, classify failures, optionally repair                 |
| `flint ci`                                | The whole pipeline in one command, headless, `--json` for CI        |
| `flint bench`                             | Measure the pipeline and write a baseline                           |

`--dir <path>` and `--help` work on all of them.

**Use `flint ci` rather than `plan` + `generate` in a loop.** `generate` gates
one feature against the suite as it currently stands, which is right for one
feature and wrong for a full run — whichever feature goes first meets the
others' un-regenerated specs. `ci` emits every feature as one batch and gates
once.

---

## Writing the knowledge base

`flint init` creates a `kb/` tree. The one file you must write is a feature
spec:

```markdown
---
id: login
title: Sign in to the application
priority: p0
acceptanceCriteria:
  - A user with valid credentials reaches the products page
  - A locked-out user sees a message explaining the account is locked
---

Users sign in from the site root. The form has a username field, a password
field, and a Login button.
```

That is enough to run `flint ci`. See **[docs/kb-authoring.md](docs/kb-authoring.md)**
for the full frontmatter reference, flow scripts (for states no link leads to),
and conventions.

---

## Configuration

`flint.config.ts` at the root of your project. The minimum:

```ts
import type { FlintConfigInput } from 'flint';

export default {
  baseUrl: 'https://test.example.com',
  envClass: 'test',
  explorer: { testIdAttribute: 'data-test' },
  models: {
    planner: 'claude-opus-5',
    coder: 'claude-opus-5',
    repair: 'claude-opus-5',
  },
} satisfies FlintConfigInput;
```

Every key, its default, and what it costs you to get it wrong:
**[docs/config-reference.md](docs/config-reference.md)**.

---

## What Flint will not do

These are deliberate, and each one exists because the alternative silently
produces something worse:

- **It will not explore a non-test environment.** `envClass` must be `test`.
- **It will not write code that does not compile.** The gate runs first; a
  failure means nothing is written.
- **It will not overwrite your edits.** Generated files carry a
  `@flint:managed <hash>` marker. Edit one and Flint notices: it keeps your
  version and writes its own beside it as `*.flint.ts`.
- **It will not erase a spec.** A run that would leave a spec file with zero
  tests refuses and says which one, rather than writing an empty file.
- **It will not call a test "passing" because it did not run.** Skipped,
  `fixme`, and flaky are counted and reported separately from passed.
- **It will not repair the application's bugs.** Assertion mismatches are
  surfaced as _possible real defects_, not patched away.

---

## Development

```bash
pnpm test     # unit + integration (needs Chromium for the browser-backed tests)
pnpm build    # tsc
pnpm lint     # eslint
```

`PHASE_NOTES.md` is the running log of decisions, deviations, and defects found
— including the ones found by running Flint against a real app. It is the most
useful file in the repo for understanding _why_ something is the way it is.

The full specification is `reference/docs/flint-master-development-plan.md`.
