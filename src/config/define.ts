import type { FlintConfigInput } from '../schemas/config.js';

/**
 * Identity helper that gives target-project `flint.config.ts` files full type
 * checking and editor autocomplete:
 *
 *   import { defineConfig } from 'flint';
 *   export default defineConfig({ ... });
 */
export function defineConfig(config: FlintConfigInput): FlintConfigInput {
  return config;
}
