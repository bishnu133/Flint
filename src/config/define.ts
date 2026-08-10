import type { TestGenConfigInput } from '../schemas/config.js';

/**
 * Identity helper that gives target-project `testgen.config.ts` files full type
 * checking and editor autocomplete:
 *
 *   import { defineConfig } from 'testgen';
 *   export default defineConfig({ ... });
 */
export function defineConfig(config: TestGenConfigInput): TestGenConfigInput {
  return config;
}
