import { describe, it, expect } from 'vitest';
import { parseJsonLoose } from './json.js';

describe('parseJsonLoose', () => {
  it('parses plain JSON', () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
  });

  it('strips ```json code fences', () => {
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('extracts a JSON object embedded in prose', () => {
    expect(parseJsonLoose('Here you go: {"a": {"b": 2}} — done')).toEqual({ a: { b: 2 } });
  });

  it('handles braces inside strings', () => {
    expect(parseJsonLoose('{"note": "a } here"}')).toEqual({ note: 'a } here' });
  });

  it('throws when no JSON is present', () => {
    expect(() => parseJsonLoose('no json at all')).toThrow(/No JSON/);
  });
});
