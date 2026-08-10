/**
 * Loose JSON extraction for structured LLM output.
 *
 * Models sometimes wrap JSON in ```json fences or add a sentence of preamble.
 * This strips fences and, failing a direct parse, extracts the first balanced
 * JSON object/array. It never guesses values — it only locates JSON already
 * present in the text.
 */
export function parseJsonLoose(text: string): unknown {
  // Direct parse first: valid JSON must never be altered, even if a string
  // value happens to contain ``` sequences that look like code fences.
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to fence stripping / extraction
  }

  const stripped = stripCodeFences(trimmed).trim();
  try {
    return JSON.parse(stripped);
  } catch {
    const candidate = extractFirstJson(stripped) ?? extractFirstJson(trimmed);
    if (candidate === undefined) {
      throw new SyntaxError('No JSON object or array found in model output');
    }
    return JSON.parse(candidate);
  }
}

function stripCodeFences(text: string): string {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  return fence?.[1] ?? text;
}

function extractFirstJson(text: string): string | undefined {
  const start = text.search(/[[{]/);
  if (start === -1) return undefined;
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}
