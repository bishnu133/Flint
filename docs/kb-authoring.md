# Writing the knowledge base

Flint learns your application two ways: by **exploring** it (which gives it
pages, elements, and selectors) and by **reading** what you write about it
(which gives it intent). Exploration cannot tell it that a locked-out user
should see a specific message, or that "checkout" means five particular steps.
That is what the knowledge base is for.

`flint init` scaffolds it:

```
kb/
├── features/          the only directory you must write in
│   └── _example.md    a worked example; `_` keeps it inert
├── app/
│   ├── overview.md    what the app is, in a paragraph
│   ├── glossary.md    business words that never appear on screen
│   ├── roles.md       user roles, and which credential getter each uses
│   ├── rules.md       constraints that make a sensible plan wrong
│   ├── entities/      how a test reaches a given state
│   ├── environments.md
│   └── flows/         scripts that reach states no link leads to
└── conventions.md     how generated tests should look
```

Only `kb/features/*.md` is required. Everything else improves the output;
nothing else blocks a run.

---

## Feature specs

One file per feature, in `kb/features/`. A spec is YAML frontmatter (the
machine-readable contract) plus a markdown body (prose the planner reads).

Files prefixed with `_` are skipped — the same convention as flow scripts. That
is why the scaffolded `_example.md` is inert: every feature spec costs a planner
call on every `flint ci`, and a brand-new project should not be paying to
generate tests for an example nobody asked for. Copy it to `login.md` (or
whatever you are covering), drop the underscore, and it runs.

```markdown
---
id: login
title: Sign in to the application
priority: p0
tags: [auth, smoke]
pages:
  - /
acceptanceCriteria:
  - A user with valid credentials reaches the products page
  - A locked-out user sees a message explaining the account is locked
negativeCases:
  - An unknown username shows an error and stays on the sign-in page
dataNeeds:
  - A standard test user
  - A locked-out test user
status: ready
---

Users sign in from the site root. The form has a username field, a password
field, and a Login button. The error banner appears above the form and can be
dismissed with an × button.
```

### Frontmatter fields

| Field                | Required | Default | What it does                                                                                                                                                                                                                                                     |
| -------------------- | :------: | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                 |    ✅    | —       | Stable identifier, kebab-case. Becomes the `@feature:<id>` tag on every generated test, the spec filename (`<id>.spec.ts`), and the key in the coverage map. **Changing it orphans the previous tests** — Flint will no longer recognise them as this feature's. |
| `title`              |    ✅    | —       | Human title. Becomes the `describe` block.                                                                                                                                                                                                                       |
| `priority`           |          | `p1`    | `p0` \| `p1` \| `p2`. Advisory: use it to decide what gets human review.                                                                                                                                                                                         |
| `pages`              |          | —       | URL or `urlPattern` hints. Narrows which Screen Model pages the planner is shown, which raises plan quality and cuts tokens on a large app. Omit it and Flint matches pages heuristically.                                                                       |
| `flows`              |          | —       | Flow-script ids relevant to this feature (see below).                                                                                                                                                                                                            |
| `tags`               |          | `[]`    | Extra Playwright tags on every generated test — `@smoke`, `@slow`, whatever you grep by.                                                                                                                                                                         |
| `acceptanceCriteria` |          | —       | **The highest-leverage field.** The planner is asked to cover each one, and the plan renderer shows you which are covered. Write them as observable outcomes, not implementation steps.                                                                          |
| `negativeCases`      |          | —       | Failure paths you explicitly want covered. Without this the planner writes mostly happy paths.                                                                                                                                                                   |
| `dataNeeds`          |          | —       | Prerequisites the app must already have. A case whose data need cannot be met is emitted as `test.fixme` tagged `@needs-setup` rather than as a passing test that silently does nothing.                                                                         |
| `status`             |          | `draft` | `draft` \| `ready` \| `generated`. Advisory.                                                                                                                                                                                                                     |

### Writing acceptance criteria that produce good tests

The planner turns each criterion into one or more test cases. The difference
between a useful criterion and a useless one is whether it names an **observable
outcome**:

| Weak                  | Strong                                                           |
| --------------------- | ---------------------------------------------------------------- |
| "Login works"         | "A user with valid credentials reaches the products page"        |
| "Errors are handled"  | "An unknown username shows 'Username and password do not match'" |
| "The cart is correct" | "The cart lists each added item with its name and price"         |

A criterion Flint cannot observe in the Screen Model — something about a
database row, an email, a log line — will come back as a `blocked` case with the
reason attached. That is the system working: it is telling you the test needs a
tool it does not have.

### One feature per file

Resist the urge to write a `kb/features/everything.md`. Features are the unit
Flint plans, generates, supersedes, and reports on. A feature that covers three
unrelated areas produces one enormous spec file, and any re-plan of it churns
all three.

---

## Flow scripts

A crawl only reaches what a link takes it to. Some states have no URL: a cart
with items in it, step three of a wizard, the error banner after a bad submit.
A **flow script** drives the app into such a state and tells Flint when to
snapshot it.

Create `kb/app/flows/cart.md`:

````markdown
---
id: populated-cart
description: A cart with one item in it
---

Adds a product, then opens the cart, so the Screen Model contains the
cart-with-contents state and not just the empty one.

```ts
export default async (page, flint) => {
  await page.goto(`${flint.baseUrl}/inventory.html`);
  await page.getByRole('button', { name: 'Add to cart' }).first().click();
  await page.getByRole('link', { name: 'Cart' }).click();
  await flint.capture('cart-with-item');
};
```
````

- Flint reads the frontmatter and the **first** `ts` code fence. Everything else
  is for humans.
- `page` is a Playwright `Page`, already authenticated per your `auth` config.
- `flint` is `{ baseUrl, capture(label?) }`. Call `capture()` at every state you
  want modelled. Never call it and Flint snapshots once, where the flow ends.
- Files prefixed with `_` are skipped, which is how the shipped `_example.md`
  stays inert.
- A flow that throws is reported by id and file; the others still run. One
  broken script never costs you the rest of the model.

Run one in isolation while writing it:

```bash
flint explore --flow populated-cart --dir $DEMO
```

---

## conventions.md

Read by the planner and reflected in what gets generated. Keep it short and
declarative — it is a style guide, not a tutorial:

```markdown
- **Page Object Model:** one class per page under `e2e/pages/`, named `<Area>Page`.
- **Test tags:** every test carries `@flint` and `@feature:<id>`.
- **Assertions:** assert the acceptance criteria, not just navigation.
- **Naming:** test titles read as user-facing behavior.
```

---

## app/ — context, not contract

`overview.md`, `roles.md`, and `environments.md` are prose given to the planner
as background. They are worth ten minutes each and no more. The highest-value
content is anything a newcomer would need explained and that the UI does not
say out loud: what "provisioning" means in your domain, which roles can see
which navigation, that the staging environment resets nightly.

---

## How Flint treats what you write

Two behaviours worth knowing, because they surprise people:

**Your feature spec is the source of truth; the previous tests are not.** When
you re-plan a feature, Flint hides the tests it generated for that feature last
time. Otherwise the planner sees its own previous output as prior art, marks
everything a duplicate, and the next generate writes an empty spec. Tests in
files _you_ have edited are treated as real prior art and are never hidden —
editing a generated file is how you tell Flint to defer to you.

**Data needs are honoured, not assumed.** A case whose `dataNeeds` cannot be
satisfied becomes `test.fixme` with `@needs-setup` and the reason in a comment.
`flint verify --ready` skips them. This is deliberate: a test that silently
passes because it never really ran is worse than one that admits it is blocked.

---

## Application knowledge — `kb/app/`

The crawler learns what a page looks like. It cannot learn that GAQ means Get
Active Questionnaire, that unfit is value 3, or that a user may only change it
once a day. That half comes from a human, and it lives here.

### Do not write these files upfront

Write your feature spec first, declaring what it needs in plain words:

```yaml
dataNeeds:
  - a user whose GAQ status is unfit
  - a user who has synced some MVPA progress
```

Then run `flint kb`:

```
mvpa-badge-gaq
  ok  a user whose GAQ status is unfit
        -> gaq.unfit via UserRepository.updateGAQ
  !!  a user who has synced some MVPA progress   (no way to reach)
        `mvpa-progress` state `synced` is recorded as unreachable:
        no DB insert exists — ActivityRepository can only deleteMVPA.
        fix: Drop this case from the spec, or add a setup path once one exists.

1 grounded, 1 gap(s) across 1 feature(s).
```

It names the entities your specs actually need and ignores everything else. A BA
fills in three specific gaps instead of documenting an application in the
abstract — which is the version that never gets finished.

### `kb/app/entities/<entity>.md`

One file per thing a test must put into a state. Filename is the id.

```yaml
---
aliases: [get active questionnaire, fitness status]
states:
  unfit:
    repository: UserRepository.updateGAQ
    note: value 3
  never-answered:
    unreachable: only set by the mobile app on first launch
---
```

Four ways to answer "how does a test reach this?" — `repository:`, `flow:`,
`api:`, or `unreachable:`.

**`repository` and `flow` are checked against your suite.** A method somebody
renamed is caught by `flint kb`, not by a failing run three weeks later. That is
the same rule Flint applies to selectors, turned on the knowledge base itself.

**`unreachable:` is a real answer, not a failure.** Left blank, the planner
cannot tell "nobody wrote this down" from "this cannot be done", and will plan a
test that can never pass.

**Aliases matter more than they look.** A JIRA card says "fitness status", your
file is called `gaq`, and without the alias the two never meet.

### The rest

- **`glossary.md`** — term to definition. Add a word when you catch yourself
  explaining it to a new joiner.
- **`roles.md`** — role to credential getter. Names the function, never a
  password. The getter is checked against your suite.
- **`rules.md`** — a plain list of constraints. "A user may change GAQ once per
  day" is the sort of thing that makes an otherwise reasonable plan wrong.

### Checking the whole thing

`flint kb` also validates the knowledge base against itself, independent of any
feature. A state nobody needs today still names a method, and if that method was
renamed last week the KB is already wrong — you just have not run the feature
that would notice.

```bash
flint kb --dir ./my-project           # report
flint kb --dir ./my-project --strict  # exit 1 on any gap, for CI
flint kb --dir ./my-project --json    # machine-readable
```
