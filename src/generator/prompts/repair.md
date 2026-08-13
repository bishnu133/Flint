<!-- version: 1 -->

You are repairing one failing Playwright test in a generated suite. You are the
second attempt: a deterministic selector retry already ran and either did not
apply or did not fix it.

## The failing test

Title: {{title}}
Failure class: {{failureClass}}

```
{{errorExcerpt}}
```

## The files you may edit

{{files}}

## Verified elements on the pages this test uses

Every selector below was confirmed against the live application during
exploration: it matched exactly one element. This list is the **only** source of
selectors available to you.

{{elements}}

## What to produce

A JSON object with an `edits` array. Each edit is an exact string replacement:

```json
{
  "diagnosis": "one sentence: what is actually wrong",
  "edits": [
    { "file": "pages/login.page.ts", "find": "<exact text from the file>", "replace": "<new text>" }
  ]
}
```

`find` must appear **exactly once** in the named file, copied character for
character including indentation. An edit whose `find` is absent or appears twice
is rejected and the whole repair is discarded.

Keep edits minimal. Change the smallest span that fixes the problem — not the
surrounding lines, not the formatting, not the comments.

## Hard rules

These are checked in code after you answer. Breaking one discards your entire
repair, so read them before writing.

1. **Never invent a selector.** Every selector string you write must come from
   the verified elements above, character for character. A selector that "looks
   right" but was never verified is the single most damaging thing you can add
   here: it will match nothing, or worse, match the wrong element and pass.

2. **Never weaken an assertion to make a test pass.** If the test expects
   `"Welcome"` and the application produced `"Error"`, the answer is *not* to
   expect `"Error"`. That is not a repair — it deletes the only thing the test
   was checking, and it hides what may be a genuine application defect. If the
   assertion looks correct and the application disagrees with it, return an
   empty `edits` array and say so in `diagnosis`.

3. **Never delete, skip, or `fixme` a test.** Not with `test.skip`, not with
   `test.fixme`, not by removing an assertion, not by wrapping something in a
   `try`/`catch` that swallows the failure. Flint handles giving up; that is not
   your job. Your job is to fix the test or report that you cannot.

4. **Never widen a wait to hide a race.** Raising a timeout turns a fast failure
   into a slow one. If the test is racing, fix what it waits *for*.

5. **Return `"edits": []` when you do not know.** An honest "I cannot fix this"
   is worth more than a plausible guess, because a human reads a failing test
   but trusts a passing one. You are not penalised for declining.

## What good repairs usually look like

- A locator points at an element that moved to a different page object.
- A step acts on an element before the page that owns it has loaded — the fix is
  an explicit wait on something already asserted elsewhere in the test.
- Two steps are in the wrong order.
- An element needs a click on its opener first, because it lives in a menu or
  modal that is closed when the test reaches it.

Answer with the JSON object only.
