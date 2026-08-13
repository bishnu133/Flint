// Type-only import: erased at load time, so this config works even before the
// `flint` package is installed locally. Install it to get editor type checking.
import type { FlintConfigInput } from 'flint';

export default {
  baseUrl: '{{baseUrl}}',
  // envClass gates dangerous operations. Never point exploration at production.
  envClass: 'test',

  suiteDir: 'e2e',
  kbDir: 'kb',

  // Auth for exploration + generated suites. Modes: none | storageState | loginScript | credentials.
  auth: { mode: 'none' },

  explorer: {
    mode: 'crawl',
    maxPages: 50,
    maxDepth: 5,
    // The crawler never clicks buttons matching these; catalogued only.
    dangerousActionPatterns: ['logout', 'delete', 'submit', 'pay', 'remove'],
    i18n: false,
    roles: [],
    // The attribute your app marks test hooks with. This is the single highest
    // -value setting here: it feeds the top-ranked selector strategy (score
    // 100). Get it wrong and Flint silently falls back to role and CSS
    // selectors, which break when someone renames a button.
    // Check your markup — saucedemo uses 'data-test', many apps use 'data-qa'.
    testIdAttribute: 'data-testid',
  },

  // Model per pipeline role — change any of these to suit your cost/quality bar.
  //
  //   planner  Stage A: feature spec -> TestPlan JSON. Reasoning-heavy; the plan
  //            determines the quality of everything downstream. Use the best model.
  //   coder    Stage B: TestPlan -> Playwright TypeScript. Runs at temperature 0
  //            against an explicit plan, so a mid-tier model is usually plenty.
  //   repair   Phase 5: diagnose a failing test and patch it. Reasoning-heavy.
  //
  // Available (most -> least capable): claude-opus-5, claude-sonnet-5,
  // claude-haiku-4-5. Raise `coder` to claude-opus-5 for maximum code quality,
  // or drop it to claude-haiku-4-5 to cut cost on large suites.
  models: {
    planner: 'claude-opus-5',
    coder: 'claude-sonnet-5',
    repair: 'claude-opus-5',
  },

  dialect: 'playwright-pom',

  debug: {
    logPrompts: false,
    verbose: false,
  },
} satisfies FlintConfigInput;
