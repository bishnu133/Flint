---
id: example-flow
description: Template for reaching an app state that no link leads to
---

# Flow scripts

A BFS crawl only sees what a link takes it to. Some states have no URL you can
navigate to: a cart with items in it, step three of a wizard, the error banner
after a bad submit. A flow script drives the app into such a state and tells
Flint when to snapshot it.

Everything outside the code block below is for humans — Flint reads only the
frontmatter and the **first** `ts` code fence.

Your script receives two arguments:

- `page` — a Playwright [`Page`](https://playwright.dev/docs/api/class-page),
  already authenticated using whatever `auth` mode `flint.config.ts` specifies.
- `flint` — `{ baseUrl, capture(label?) }`. Call `capture()` at each state you
  want in the Screen Model; captures are numbered in call order. If you never
  call it, Flint snapshots once where the flow ends.

**This file does not run.** Flint skips `_`-prefixed files, so the placeholder
below never executes against your app. Copy it to a name without the
underscore — `cart.md`, `checkout.md` — and it becomes a live flow. The
filename is the flow id when the frontmatter has no `id:`.

```ts
export default async (page, flint) => {
  await page.goto(`${flint.baseUrl}/`);

  // Drive the app into the state you care about.
  // await page.getByRole('button', { name: 'Add to cart' }).click();
  // await page.getByRole('link', { name: 'Cart' }).click();

  // Snapshot it. Give it a label so the logs are readable.
  await flint.capture('starting-point');
};
```

Run just this flow with:

```
flint explore --flow example-flow
```

A flow that throws is reported by id and file, and the other flows still run —
one broken script never costs you the rest of the model.
