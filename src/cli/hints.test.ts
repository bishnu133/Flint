import { describe, it, expect } from 'vitest';
import { dirSuffix, displayPath } from './hints.js';

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

describe('displayPath', () => {
  it('is relative when the file is under the shell’s directory', () => {
    expect(displayPath('/work/demo/.flint/reports/r.json', '/work/demo')).toBe(
      '.flint/reports/r.json',
    );
  });

  it('is absolute when the file is somewhere else entirely', () => {
    // The failure this exists for: `verify --dir ~/flint-demo` run from the
    // Flint checkout printed `.flint/reports/…`, which `cat` could not find.
    expect(displayPath('/Users/x/flint-demo/.flint/reports/r.json', '/Users/x/Flint')).toBe(
      '/Users/x/flint-demo/.flint/reports/r.json',
    );
  });

  it('falls back to the absolute path rather than printing nothing', () => {
    expect(displayPath('/work/demo', '/work/demo')).toBe('/work/demo');
  });
});
