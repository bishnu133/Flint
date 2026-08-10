/**
 * Public API surface for TestGen.
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
  TestGenError,
  ConfigError,
  TemplateError,
  ProviderError,
  StructuredOutputError,
  ScaffoldError,
  isTestGenError,
} from './shared/errors.js';
export {
  SELECTOR_STRATEGIES,
  SELECTOR_STRATEGY_SCORES,
  NON_UNIQUE_SCORE_MULTIPLIER,
  scoreSelector,
  type SelectorStrategy,
} from './shared/selector-ranking.js';
