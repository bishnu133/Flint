// Type-only import: erased at load time, so this config works even before the
// `testgen` package is installed locally. Install it to get editor type checking.
import type { TestGenConfigInput } from 'testgen';

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
  },

  // Model per role. Planner/repair use a stronger model; coder a cheaper one.
  models: {
    planner: 'claude-sonnet-4-5',
    coder: 'claude-haiku-4-5',
    repair: 'claude-sonnet-4-5',
  },

  dialect: 'playwright-pom',

  debug: {
    logPrompts: false,
    verbose: false,
  },
} satisfies TestGenConfigInput;
