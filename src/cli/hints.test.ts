import { describe, it, expect } from 'vitest';
import { dirSuffix } from './hints.js';

describe('dirSuffix', () => {
  it('echoes the caller’s own --dir, because that is the case that needs it', () => {
    // These commands are usually run from a different directory than the
    // project they target. A suggested command without --dir would be wrong in
    // exactly the situation where the hint matters most.
    expect(dirSuffix('/Users/x/flint-demo')).toBe(' --dir /Users/x/flint-demo');
  });

  it('says nothing when the default is in use', () => {
    expect(dirSuffix('.')).toBe('');
    expect(dirSuffix('')).toBe('');
    expect(dirSuffix(undefined)).toBe('');
  });
});
