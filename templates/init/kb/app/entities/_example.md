---
aliases: [get active questionnaire, fitness status]
states:
  fit:
    repository: UserRepository.updateGAQ
    note: value 1
  partial-fit:
    repository: UserRepository.updateGAQ
    note: value 2
  unfit:
    repository: UserRepository.updateGAQ
    note: value 3
  never-answered:
    unreachable: only set by the mobile app on first launch; no test path exists
---

# GAQ — Get Active Questionnaire

One file per thing a test needs to put into a particular state. The filename is
the entity id, so this file would be `gaq.md` — the `_` prefix keeps this
example inert, exactly like `kb/features/_example.md`.

## What goes in `states`

Each state answers one question: **how does a test reach this?** Four ways:

| Key | Meaning |
| --- | --- |
| `repository:` | A data-access method — `UserRepository.updateGAQ` |
| `flow:` | An existing flow in the suite — `badge-creation.createBadge` |
| `api:` | A service call |
| `unreachable:` | There is no way, and why — this is a real answer |

`repository` and `flow` are checked against the suite by `flint kb`, so a
renamed method is caught before it wastes a generation run.

**`unreachable` is not an admission of defeat.** Left blank, the planner cannot
tell "nobody wrote this down" from "this cannot be done", and will happily plan
a test that can never pass. Recording the dead end is what stops that.

## How specs reach this

A feature spec refers to a state in plain words:

```yaml
dataNeeds:
  - a user whose GAQ status is unfit
```

`flint kb` resolves that against the `aliases` and `states` above. It does not
need a special syntax — write the sentence a tester would write.

## Do not write this file from scratch

Run `flint kb`. It names the entities your specs actually need and skips the
ones nobody has asked for.
