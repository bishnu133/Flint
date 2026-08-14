# Testing Phase 6 locally

Two things to try: `flint ci` (6.1) and drift mode (6.2). Each step says what a
correct result looks like, so a wrong one is recognisable rather than merely
disappointing.

Same two-directory rule as Phase 5 — **every command runs from the Flint
checkout** and points at the demo project with `--dir`:

```bash
cd ~/Documents/Initiative/Flint
export DEMO=~/flint-demo
export ANTHROPIC_API_KEY=sk-ant-...        # rotate the leaked one first
```

Behind a TLS-inspecting proxy add `NODE_OPTIONS=--use-system-ca`. Never set
`NODE_TLS_REJECT_UNAUTHORIZED=0`.

---

## 0. Update and confirm the toolchain

```bash
git checkout claude/flint-phase-1-explorer
git pull origin claude/flint-phase-1-explorer
pnpm install
pnpm build
pnpm test          # expect: 68 files, 942 tests, 0 failed
pnpm lint          # expect: no output
```

If `pnpm test` is not green, stop — nothing below will mean anything.

---

## 1. `flint ci` — the whole pipeline, one gate

This is the command that would have prevented the `login`/`cart` failure.

```bash
pnpm cli ci --dir $DEMO
```

**Expect:**

- `Planning N feature(s): login, cart` — one LLM call per feature
- `Wrote N file(s) to e2e`, then the verify run and its pass rate
- **No compile-gate failure naming a spec the run "didn't touch".** That was the
  old single-feature failure mode; the batch makes it structurally impossible.

If the gate _does_ fail with `Property 'somethingButton2' does not exist on type
'SomePage'`, read the paragraph it now prints underneath: you have hand-edited a
page object, Flint kept your version and wrote its own beside it as `.flint.ts`,
and the new specs are written against Flint's. That failure repeats forever until
you merge the two or delete your copy — the message names both files and the
exact `rm`. Nothing is written in the meantime, including the plans.

Then the machine-readable form CI would consume:

```bash
pnpm -s cli ci --dir $DEMO --json --no-verify | jq .ok
echo "exit: ${PIPESTATUS[0]}"
```

Note the `-s`: `pnpm run` prints its own `> flint@0.0.0 cli` banner to stdout,
which lands in the pipe ahead of the JSON. That is pnpm, not Flint — an
installed `flint` binary needs no flag — but it will break `jq` every time
without it.

**Expect:** `true`, and `exit: 0`.

---

## 2. Drift mode with nothing wrong

```bash
pnpm cli explore --diff --dir $DEMO
echo "exit: $?"
```

**Expect:** `No changes.` and `exit: 0`, or a small diff followed by
`Drift impact: no test in the suite addresses anything that changed.`

A false alarm here is a bug — tell me if you see tests listed when the app has
not changed.

---

## 3. Drift drill — make the app "change" on purpose

Saucedemo will not change for us, so we move the baseline instead: doctor the
stored Screen Model, generate against it, and let the real app be the drift.

**a. Back up the model.** Everything below is reversible from this file.

```bash
cp $DEMO/.flint/screen-model/model.json /tmp/flint-model.backup.json
```

**b. Rename the login button's test id in the stored model only:**

```bash
perl -pi -e 's/login-button/login-button-OLD/g' $DEMO/.flint/screen-model/model.json
grep -c login-button-OLD $DEMO/.flint/screen-model/model.json   # expect: 2 or more
```

**c. Generate page objects that use the fake address:**

```bash
pnpm cli ci --dir $DEMO --no-verify
grep -n "login-button-OLD" $DEMO/e2e/pages/*.page.ts            # expect: a hit
```

The suite now compiles but addresses a button that does not exist — precisely
the state a real UI change leaves you in.

**d. Ask what it costs:**

```bash
pnpm cli explore --diff --dir $DEMO
echo "exit: $?"
```

**Expect:** a diff showing `-selector [testid] [data-test="login-button-OLD"]`,
then:

```
Drift impact: N test(s) will break, M more at risk.

Page objects:
  ✗ <SomePage>  e2e/pages/....page.ts
      <element-id>  lost 1 selector(s): [data-test="login-button-OLD"]
Tests:
  ✗ <the login test titles>
      e2e/tests/login.spec.ts  [@feature:login]

Next:
  flint explore --diff --fix-page-objects
  ...
```

and `exit: 1` (drift gates CI). The tests named must be the **login** ones —
if it names every test in the suite, that is the over-reporting failure mode and
I want to see it.

**e. Repair, page objects only:**

```bash
pnpm cli explore --diff --fix-page-objects --dir $DEMO
echo "exit: $?"
```

**Expect:** `Re-pointed 1 page object file(s); specs untouched.`, `The existing
specs still compile against them.`, `Screen Model updated: …`, and `exit: 0`.

Confirm the claim rather than trusting it:

```bash
grep -c "login-button-OLD" $DEMO/e2e/pages/*.page.ts   # expect: 0
git -C $DEMO diff --stat                               # if the demo is a git repo:
                                                       # only pages/ changed, no tests/
```

**f. Prove the suite actually still passes:**

```bash
pnpm cli verify --dir $DEMO
```

**Expect:** the same pass rate as step 1. A repair that compiles but fails at
runtime would be a real defect.

**g. If anything goes sideways**, restore and regenerate:

```bash
cp /tmp/flint-model.backup.json $DEMO/.flint/screen-model/model.json
pnpm cli ci --dir $DEMO
```

---

## 4. The refusal path (optional, 2 minutes)

The interesting half of `--fix-page-objects` is what it does when a re-point
_cannot_ work. Delete an element from the stored model instead of renaming it:

```bash
cp $DEMO/.flint/screen-model/model.json /tmp/flint-model.backup.json
# then in an editor, delete one element object the login spec uses,
# from $DEMO/.flint/screen-model/model.json
pnpm cli explore --diff --fix-page-objects --dir $DEMO
```

**Expect:** `Page objects were NOT written: the existing specs no longer compile
against the new Screen Model.`, the tsc errors, the locators whose elements are
gone, and `Re-plan instead:  flint ci`. Nothing in `e2e/` should have changed,
**and the Screen Model on disk must still be the old one** — accepting it would
hide the drift.

Restore with the backup afterwards.

---

## 5. Record the benchmark baseline (6.3)

This is a Phase 6 exit criterion — the numbers V2 has to beat. It runs the whole
pipeline once and writes `benchmarks/baseline.md` into the demo project.

```bash
pnpm cli bench --dir $DEMO --validate
```

`--validate` adds the selector re-resolve rate, which needs a browser and about
a minute. Without it that row reads `not measured` rather than a made-up 100%.

**Expect:** a headline block, then a file written. Costs are estimates from
published list prices with the date they were checked printed beside them.

```
Compile rate              100.0%
First-run pass            84.6%
Post-repair pass          100.0%
Selector re-resolve rate  100.0%

Baseline written to ~/flint-demo/benchmarks/baseline.md
```

If the headline block is followed by **`⚠️ This is NOT a usable baseline`**, the
run did not complete — the file is written but stamped provisional, and it is
not the number V2 has to beat. Fix what it names (almost always a compile-gate
failure) and re-run before committing anything.

Send me the contents of `benchmarks/baseline.md`. Do **not** commit it yet —
section 6 sets the repository up properly first.

---

## 6. Open a pull request (6.5)

**Set the repository up first.** `flint init` does not create one, and — this is
the part that bites — it does not write a `.gitignore` either, so the suite's
own `node_modules/` counts as a change under `e2e/`. Do not run `git add -A`
here: that commits the generated suite, after which `flint pr` correctly reports
there is nothing left to propose.

If `$DEMO` is already a repo with everything committed, start it over:

```bash
rm -rf $DEMO/.git
git -C $DEMO init -q

cat > $DEMO/.gitignore <<'EOF'
e2e/node_modules/
e2e/test-results/
e2e/playwright-report/
e2e/blob-report/
.DS_Store
.env
EOF

# commit everything EXCEPT what Flint owns, so `pr` has something to propose
git -C $DEMO add .gitignore flint.config.ts kb/ benchmarks/
git -C $DEMO commit -qm "chore: project scaffold and benchmark baseline"
```

If you skip the `.gitignore`, `flint pr` refuses and prints that exact file —
that is the guard working, not a failure.

**Look before it touches anything:**

```bash
pnpm cli pr --dir $DEMO --dry-run
```

**Expect:** the exact file list it would commit, any unrelated changes it is
leaving alone, and the full PR body. Nothing changes on disk.

Check the first line of the body — it should be a claim about evidence
(`**11 of 12 tests pass.**`), not a count of generated tests. If it says
`**Not verified**`, run `flint verify --dir $DEMO` first so the PR carries a
run report.

**Commit locally (still no push):**

```bash
pnpm cli pr --dir $DEMO
```

**Expect:** `Committed <sha> on flint/<timestamp>`, then the two commands to
finish. Confirm it only took what it should:

```bash
git -C $DEMO show --name-only --format= HEAD
```

Everything listed must be under `e2e/` or `.flint/`. Anything else is a bug and
I want to know immediately.

**Push and open the PR** (only when the above looks right):

```bash
export GITHUB_TOKEN=ghp_...          # needs `repo` scope
pnpm cli pr --dir $DEMO --push --branch <the branch it just made>
```

**Expect:** `Pushed …`, then `Pull request #N: https://github.com/…`.

Without a token it still pushes and prints a `compare` URL to finish in the
browser — that is a valid outcome, not a failure.

**If you would rather not push at all**, stop after the local commit and undo it
with:

```bash
git -C $DEMO checkout - && git -C $DEMO branch -D flint/<timestamp>
```

---

## What to send back

The terminal output of **1**, **3d**, **3e**, **3f**, and **5**, plus the
`git show --name-only` output from **6**. Those cover every Phase 6 claim; the
rest is scaffolding.
