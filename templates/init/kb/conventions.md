# Suite Conventions

> How generated tests should look. Flint reads this to match your house style.

- **Page Object Model:** one class per page under `e2e/pages/`, named `<Area>Page`.
- **Selectors:** prefer `data-testid`; Flint only emits selectors verified during exploration.
- **Test tags:** every test carries `@flint` and `@feature:<id>`.
- **Assertions:** assert the acceptance criteria, not just navigation.
- **Data:** use data factories under `e2e/data/` with unique suffixes to avoid collisions.
- **Naming:** test titles read as user-facing behavior ("User can reset their password").
