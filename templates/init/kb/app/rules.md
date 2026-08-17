# Rules

Constraints a test must respect. Written as a plain list; the planner reads them
alongside the feature spec.

These are the things that make a reasonable-looking test plan wrong:

- A user may change their fitness status only once per calendar day.
- Orders over $500 require a second approver, so a single-user test cannot
  complete checkout above that amount.

Delete the examples and write your own. Two real rules beat twenty invented ones.
