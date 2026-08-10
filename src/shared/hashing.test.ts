import { describe, it, expect } from 'vitest';
import { stableStringify, hashValue, sha256 } from './hashing.js';

describe('stableStringify', () => {
  it('produces identical output regardless of key order', () => {
    const a = { b: 1, a: 2, nested: { y: 1, x: 2 } };
    const b = { a: 2, nested: { x: 2, y: 1 }, b: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it('preserves array order (arrays are ordered data)', () => {
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]');
  });
});

describe('hashValue', () => {
  it('is deterministic and key-order independent', () => {
    expect(hashValue({ a: 1, b: 2 })).toBe(hashValue({ b: 2, a: 1 }));
  });

  it('differs for different content', () => {
    expect(hashValue({ a: 1 })).not.toBe(hashValue({ a: 2 }));
  });

  it('sha256 matches a known digest', () => {
    // echo -n "" | sha256sum
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});
