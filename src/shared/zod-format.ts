import type { ZodError } from 'zod';

/**
 * Turn a {@link ZodError} into a human-readable, multi-line message where each
 * issue names the offending key path. This is what makes config errors say
 * `explorer.maxPages: Expected number, received string` instead of dumping a
 * raw stack trace.
 */
export function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `  - ${path}: ${issue.message}`;
    })
    .join('\n');
}

/** The dotted key path of the first issue, e.g. `explorer.maxPages`. */
export function firstBadKey(error: ZodError): string {
  const first = error.issues[0];
  if (first === undefined) return '(root)';
  return first.path.length > 0 ? first.path.join('.') : '(root)';
}
