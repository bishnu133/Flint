import { pino, type Logger, type Level } from 'pino';

export type { Logger };

export interface LoggerOptions {
  /** Raise log level to `debug` and enable per-call detail. */
  verbose?: boolean;
  /** Force a specific pino level (overrides `verbose`). */
  level?: Level;
}

/**
 * Create the shared pino logger.
 *
 * Kept dependency-light: pretty-printing is intentionally not wired in Phase 0
 * to avoid an extra runtime dependency. Structured JSON logs are fine for the
 * CLI and are what CI wants anyway.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? (options.verbose ? 'debug' : 'info');
  return pino({
    level,
    base: undefined, // omit pid/hostname noise
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

/** A no-op logger for tests and library callers that do not want output. */
export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}
