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
│   └── example.md
├── app/
│   ├── overview.md    what the app is, in a paragraph
│   ├── roles.md       user roles and what each can do
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
