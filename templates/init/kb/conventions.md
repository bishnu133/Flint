# House conventions

Read verbatim by `flint plan` and handed to the planner with every feature.
This is where a judgement belongs — something a person would say in review that
a generator cannot derive from the code.

Structural rules do **not** belong here. "Import the base URL constant rather
than a literal", "flows never assert" and "call `act(engine, phrase)`" are
enforced by the emitter, deterministically, every time. A rule written here is
followed by a model on a good day.

Delete the examples below and write your own. An empty file is fine; a wrong one
is not, because the planner will follow it.

## Coverage

- An acceptance criterion joined by `AND` is one requirement with several
  observable outcomes. Cover all of them.
- Assert the outcome the criterion describes, not that a page loaded.
- A clause the Screen Model cannot support is an `openQuestions` entry naming
  the clause — never a silent omission.

## Assertions

- Prefer the most specific check the suite can express. If its tests assert a
  table row's contents, checking that the table is visible is weaker than the
  suite is capable of.
- State an absence as an absence. "Add a facilitator is not present" is the
  requirement; "is hidden" is a claim about CSS.

## Data

- One account per role, named by its credential getter.
- Unique names come from the suite's own templating rather than a literal, so
  two runs do not collide.
