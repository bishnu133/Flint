/**
 * Public API surface for Flint.
 *
 * Target projects import `defineConfig` from here; downstream tooling and later
 * phases import schemas, the provider interface, and the template loader. The
 * CLI lives at `src/cli` and is not re-exported.
 */
export * from './schemas/index.js';
export { defineConfig, loadConfig, loadConfigFromPath, findConfigFile } from './config/index.js';
export * from './llm/index.js';
export {
  loadTemplate,
  renderTemplate,
  loadAndRender,
  type PromptTemplate,
} from './generator/template-loader.js';
export {
  FlintError,
  ConfigError,
  TemplateError,
  ProviderError,
  StructuredOutputError,
  ScaffoldError,
  isFlintError,
} from './shared/errors.js';
export {
  SELECTOR_STRATEGIES,
  SELECTOR_STRATEGY_SCORES,
  NON_UNIQUE_SCORE_MULTIPLIER,
  scoreSelector,
  type SelectorStrategy,
} from './shared/selector-ranking.js';
