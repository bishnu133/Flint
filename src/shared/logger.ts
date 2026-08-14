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
 *
 * **Logs go to stderr, not stdout** (fixed after Phase 6; see PHASE_NOTES 6.7).
 * Sharing stdout with the CLI's own output was wrong twice over. Functionally,
 * `flint ci --json` is meant to be piped into `jq`, and log lines landing inside
 * the summary object make it unparseable — which defeats the point of having a
 * machine-readable mode at all. Cosmetically, pino and `console.log` are two
 * separately buffered writers on one fd, so their output interleaved out of
 * order and, in one live run, printed sixty blank lines through the middle of a
 * message. stdout is the product; stderr is the commentary.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? (options.verbose ? 'debug' : 'info');
  return pino(
    {
      level,
      base: undefined, // omit pid/hostname noise
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    process.stderr,
  );
}

/** A no-op logger for tests and library callers that do not want output. */
export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}
