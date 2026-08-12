import type { Dialect as DialectName } from '../../schemas/config.js';
import { ConfigError } from '../../shared/errors.js';
import { playwrightPomDialect } from './playwright-pom.js';
import type { Dialect } from './types.js';

export type { Dialect } from './types.js';
export * from './types.js';
export { playwrightPomDialect } from './playwright-pom.js';

/**
 * Resolve `config.dialect` to an implementation.
 *
 * `bubblegum` is in the LOCKED config enum from Phase 0 but is a Phase 6
 * stretch goal, so selecting it is a config error with a specific message
 * rather than a silent fall back to the default — a suite emitted in the wrong
 * dialect would be worse than a refusal.
 */
export function resolveDialect(name: DialectName): Dialect {
  switch (name) {
    case 'playwright-pom':
      return playwrightPomDialect;
    case 'bubblegum':
      throw new ConfigError('The `bubblegum` dialect is not implemented yet.', {
        hint: "Set `dialect: 'playwright-pom'` in flint.config.ts. Bubblegum lands in Phase 6.",
      });
  }
}
