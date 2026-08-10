/**
 * Custom error classes for Flint.
 *
 * Every error carries an actionable message: it names the config key, env var,
 * file path, or template placeholder the user must fix. The CLI catches
 * {@link FlintError} and prints `error.message` only — never a raw stack trace.
 */

/** Base class for all expected, user-actionable Flint errors. */
export class FlintError extends Error {
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
export class ConfigError extends FlintError {
  constructor(message: string, options: { hint?: string; cause?: unknown } = {}) {
    super(message, { code: 'CONFIG', ...options });
  }
}

/** A prompt template is missing, malformed, or a placeholder was not supplied. */
export class TemplateError extends FlintError {
  constructor(message: string, options: { hint?: string; cause?: unknown } = {}) {
    super(message, { code: 'TEMPLATE', ...options });
  }
}

/** An LLM provider is misconfigured (e.g. missing API key) or a call failed. */
export class ProviderError extends FlintError {
  constructor(message: string, options: { hint?: string; cause?: unknown } = {}) {
    super(message, { code: 'PROVIDER', ...options });
  }
}

/** A structured LLM response failed schema validation after retries. */
export class StructuredOutputError extends FlintError {
  constructor(message: string, options: { hint?: string; cause?: unknown } = {}) {
    super(message, { code: 'STRUCTURED_OUTPUT', ...options });
  }
}

/** The `flint init` scaffolder refused to clobber existing files. */
export class ScaffoldError extends FlintError {
  constructor(message: string, options: { hint?: string; cause?: unknown } = {}) {
    super(message, { code: 'SCAFFOLD', ...options });
  }
}

/** Type guard for Flint's own errors. */
export function isFlintError(err: unknown): err is FlintError {
  return err instanceof FlintError;
}
