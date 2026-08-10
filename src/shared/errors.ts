/**
 * Custom error classes for TestGen.
 *
 * Every error carries an actionable message: it names the config key, env var,
 * file path, or template placeholder the user must fix. The CLI catches
 * {@link TestGenError} and prints `error.message` only — never a raw stack trace.
 */

/** Base class for all expected, user-actionable TestGen errors. */
export class TestGenError extends Error {
  /** Machine-readable code for programmatic handling and tests. */
  readonly code: string;
  /** Optional extra hint appended by the CLI presenter. */
  readonly hint: string | undefined;

  constructor(message: string, options: { code: string; hint?: string; cause?: unknown }) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code;
    this.hint = options.hint;
  }
}

/** Configuration is missing, unreadable, or fails schema validation. */
export class ConfigError extends TestGenError {
  constructor(message: string, options: { hint?: string; cause?: unknown } = {}) {
    super(message, { code: 'CONFIG', ...options });
  }
}

/** A prompt template is missing, malformed, or a placeholder was not supplied. */
export class TemplateError extends TestGenError {
  constructor(message: string, options: { hint?: string; cause?: unknown } = {}) {
    super(message, { code: 'TEMPLATE', ...options });
  }
}

/** An LLM provider is misconfigured (e.g. missing API key) or a call failed. */
export class ProviderError extends TestGenError {
  constructor(message: string, options: { hint?: string; cause?: unknown } = {}) {
    super(message, { code: 'PROVIDER', ...options });
  }
}

/** A structured LLM response failed schema validation after retries. */
export class StructuredOutputError extends TestGenError {
  constructor(message: string, options: { hint?: string; cause?: unknown } = {}) {
    super(message, { code: 'STRUCTURED_OUTPUT', ...options });
  }
}

/** The `testgen init` scaffolder refused to clobber existing files. */
export class ScaffoldError extends TestGenError {
  constructor(message: string, options: { hint?: string; cause?: unknown } = {}) {
    super(message, { code: 'SCAFFOLD', ...options });
  }
}

/** Type guard for TestGen's own errors. */
export function isTestGenError(err: unknown): err is TestGenError {
  return err instanceof TestGenError;
}
