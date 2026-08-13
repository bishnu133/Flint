# Testing Phase 5 locally

A step-by-step for verifying the Verifier against saucedemo. Each part says what
you should see, so a wrong result is recognisable rather than merely
disappointing.

---

## Where to run things — read this first

Two directories are involved and they are not the same place:

|                        | What it is                                                               | Example                        |
| ---------------------- | ------------------------------------------------------------------------ | ------------------------------ |
| **The Flint checkout** | The tool. Holds `package.json`, so `pnpm cli` only works here.           | `~/Documents/Initiative/Flint` |
| **The demo project**   | The thing under test. Holds `flint.config.ts`, `kb/`, `e2e/`, `.flint/`. | `~/flint-demo`                 |

**Every command in this guide runs from the Flint checkout**, and points at the
demo project with `--dir`. Set this once per shell:

```bash
cd ~/Documents/Initiative/Flint
export DEMO=~/flint-demo
```

`cd`-ing into the demo project and running `pnpm cli` there does **not** work —
`cli` is a script in Flint's `package.json`, so pnpm falls through to the
registry and fails on whatever your `~/.npmrc` says. If you see

```
[ERROR] Failed to decode _auth as base64
```

that is what happened: you were in the wrong directory. It is not a Flint error
and not an npm credentials problem to go and fix.

The related `WARN Issue while reading ~/.npmrc: Failed to replace env in config:
${GITLAB_NPM_TOKEN}` is harmless here — that variable is not exported and
nothing in this guide needs your private registry. Ignore it.

---

## 0. Prerequisites, once

```bash
git checkout claude/flint-phase-1-explorer
git pull origin claude/flint-phase-1-explorer
pnpm install
pnpm build
```

Then confirm the toolchain is clean before testing behaviour:

```bash
pnpm test        # expect: 54 files, 814 tests, 0 failed
pnpm lint        # expect: no output
```

If `pnpm test` is not green, stop here — nothing below will mean anything.

**API key.** The LLM repair path needs one. Rotate the key you pasted into a log
earlier if you have not already; it should be treated as compromised.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Behind your TLS-inspecting proxy, use `NODE_OPTIONS=--use-system-ca`. Never set
`NODE_TLS_REJECT_UNAUTHORIZED=0`.

---

## 1. Set `testIdAttribute` — do this before anything else

Saucedemo marks its hooks `data-test`, not `data-testid`. Until this is set,
Flint builds **no** test-id selectors for it and silently falls back to role and
CSS. In `$DEMO/flint.config.ts`:

```ts
explorer: {
  // ...
  testIdAttribute: 'data-test',
},
```

**Expect churn, and expect it to be correct.** `elementId` hashes the test id, so
every element carrying a `data-test` attribute gets a new id. Your existing plan
references the old ids and the referential validator will reject it. That is the
validator working, not a bug. The next section re-runs the pipeline, which is
what fixes it.

---

## 2. Rebuild the pipeline from scratch

```bash
pnpm cli explore   --dir "$DEMO"
pnpm cli index     --dir "$DEMO"
pnpm cli plan      --dir "$DEMO"
pnpm cli generate  --dir "$DEMO"
```

**What to check as you go**

- `explore` — the summary should now report `testid` as the top strategy for most
  elements. If you still see `role` and `css` everywhere, step 1 did not take.
- `plan` — if it errors with "references elements that do not exist", your
  Screen Model and plan are out of step; re-run `explore` then `plan` again.
- `generate` — the compile gate must say it **ran**. A skipped gate is the bug
  that hid for weeks in Phase 4. If it reports skipped, say so rather than
  continuing.

---

## 3. Install the suite's own dependencies

The generated suite is standalone — it does not depend on Flint at runtime.

```bash
cd "$DEMO/e2e"
npm install
npx playwright install chromium
cd -
```

---

## 4. Baseline: verify with no repair

```bash
pnpm cli verify --dir "$DEMO"
```

**Expect**

- A health check line first. If saucedemo is unreachable you get a plain
  statement and every failure classified `env` — no test is blamed.
- A summary with a pass rate expressed as a fraction _of what actually ran_.
- `Report written to .flint/reports/<runId>.json` (under `$DEMO`).
- Exit code 1 if anything failed, 0 if all green (`echo $?`).

**The thing worth checking**: if nothing ran, the output must say so explicitly
and exit 1. "We could not run" must never read as "nothing failed".

---

## 5. Repair, deterministic only

This is the half that needs no model and no key.

```bash
pnpm cli verify --dir "$DEMO" --repair --no-llm
```

With a green suite this does nothing. To see it work, break a selector on
purpose — edit a page object in `$DEMO/e2e/pages/` and change one `data-test` value to
something that does not exist:

```ts
// before
this.userNameInput = this.page.locator('[data-test="username"]');
// after
this.userNameInput = this.page.locator('[data-test="username-typo"]');
```

Then:

```bash
pnpm cli verify --dir "$DEMO" --repair --no-llm
```

**Expect, in order**

1. The test fails, classified `selector-not-found`.
2. The test is re-run **alone first** — this is the isolation check. It fails
   alone too, so repair proceeds.
3. A `Repairs:` section showing `1. [selector-retry] el-…: testid -> role`.
4. The page object now uses `getByRole(...)`, and the test passes.

**What must NOT happen**: a selector that was never in the Screen Model. Every
replacement comes from verified candidates only.

If it cannot fix it (delete the locator line entirely, say), expect the test to
be marked `test.fixme` in the spec with a comment block explaining what was
tried. Open the spec and read it — that block is the deliverable.

---

## 6. Repair with the model

```bash
pnpm cli verify --dir "$DEMO" --repair
```

Break something the selector retry cannot fix — reorder two steps in a spec, or
point an action at an element that belongs to a different page object.

**Expect**

- The deterministic retry is tried first and declines, with the reason stated.
- One model call, at temperature 0.
- Either a patch that survives validation, or a refusal that names the rule it
  broke.

**Deliberately test a refusal.** This is the part most worth your time, because
it is the part that protects you. Make an assertion genuinely wrong in a way the
app disagrees with — for example, change an expected error message to something
saucedemo will never produce. The model will be tempted to rewrite the
expectation to match what the app returned. It must be refused with a message
about deleting what the test was checking, and the test must be flagged as a
**possible application defect**.

If a repair ever makes a test pass by weakening an assertion, that is a serious
bug — tell me and I will treat it as such.

**Without a key** the command does not fail. It degrades to deterministic-only
and says so.

---

## 7. Flaky / interference detection

```bash
pnpm cli verify --dir "$DEMO" --repair
```

To provoke it, make two tests fight over the same state — for example, have one
test log out while another is mid-session, or point two tests at the same cart.

**Expect**

- The test fails in the full run and **passes alone**.
- It is marked `flaky`, not `failed`, and repair does not touch it.
- A section naming the tests and giving two remedies: `--workers=1` to confirm,
  then unique factory data or `test.describe.serial`. Session expiry is named as
  the other cause with the same signature.

---

## 8. Environment failure

```bash
# point at somewhere that is not there
pnpm cli verify --dir "$DEMO" --repair
```

with `baseUrl` in `$DEMO/flint.config.ts` temporarily set to
`https://localhost:9999`.

**Expect**

- The health check fails before the run.
- Every failure classified `env`.
- Repair explicitly **skipped**, with the reason — patching a test cannot start
  a stopped server.
- Exit code 1.

Put `baseUrl` back afterwards.

---

## 9. The exit criterion

The master plan's Phase 5 bar is **post-repair pass rate ≥90% on the golden
set**. Run the full pipeline clean and read the pass-rate line:

```bash
pnpm cli verify --dir "$DEMO" --repair
```

Send me the output. What I need to see is the summary block, the `Repairs:`
section, and whether any test was marked `fixme`.

One caveat I would rather state than have you discover: a `fixme` test drops out
of the pass-rate denominator on subsequent runs, so a suite that gives up on
everything could report a flattering number. Read the `fixme` count next to the
pass rate, never the pass rate alone. This run's report still counts a repaired-
and-failed test as `failed` for exactly that reason.

---

## Quick reference

```bash
pnpm cli verify --dir "$DEMO"                          # run and report, no changes
pnpm cli verify --dir "$DEMO" --repair                 # selector retry, then a model
pnpm cli verify --dir "$DEMO" --repair --no-llm        # verified selectors only
pnpm cli verify --dir "$DEMO" --feature login          # one feature
pnpm cli verify --dir "$DEMO" --ready                  # skip @needs-setup tests
pnpm cli verify --dir "$DEMO" --no-health-check        # run even if the app is silent
pnpm cli verify --dir "$DEMO" -v                       # verbose logging
```

Reports accumulate in `$DEMO/.flint/reports/`. They are plain JSON — diff two runs to
see what changed.
