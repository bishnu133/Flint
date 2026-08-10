import { describe, it, expect } from 'vitest';
import { describeRequestFailure, validateStructured } from './anthropic.js';
import { z } from 'zod';

/** Build a Node-style system error with a `code` property. */
function sysError(message: string, code: string): Error {
  const err = new Error(message);
  (err as Error & { code: string }).code = code;
  return err;
}

describe('describeRequestFailure', () => {
  it('surfaces the underlying DNS failure behind a bare "Connection error."', () => {
    const err = new Error('Connection error.', {
      cause: sysError('getaddrinfo ENOTFOUND api.anthropic.com', 'ENOTFOUND'),
    });
    const hint = describeRequestFailure(err);
    expect(hint).toMatch(/ENOTFOUND/);
    expect(hint).toMatch(/DNS/);
  });

  it('names the proxy for a refused connection', () => {
    const err = new Error('Connection error.', {
      cause: sysError('connect ECONNREFUSED 1.2.3.4:443', 'ECONNREFUSED'),
    });
    expect(describeRequestFailure(err)).toMatch(/HTTPS_PROXY/);
  });

  it('points at the CA bundle for a TLS-inspecting proxy', () => {
    const err = new Error('Connection error.', {
      cause: sysError('self-signed certificate in chain', 'SELF_SIGNED_CERT_IN_CHAIN'),
    });
    expect(describeRequestFailure(err)).toMatch(/NODE_EXTRA_CA_CERTS/);
  });

  it('walks a nested cause chain to find the diagnosable link', () => {
    const root = sysError('connect ETIMEDOUT', 'ETIMEDOUT');
    const middle = new Error('fetch failed', { cause: root });
    const top = new Error('Connection error.', { cause: middle });
    expect(describeRequestFailure(top)).toMatch(/timed out/i);
  });

  it('still guides the user when there is no cause at all', () => {
    const hint = describeRequestFailure(new Error('Connection error.'));
    expect(hint).toMatch(/api\.anthropic\.com/);
    expect(hint).toMatch(/HTTPS_PROXY/);
  });

  it('is cycle-safe', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as Error).cause = b;
    const top = new Error('Connection error.', { cause: b });
    expect(() => describeRequestFailure(top)).not.toThrow();
  });

  it('passes through an ordinary API error message', () => {
    expect(describeRequestFailure(new Error('404 model not found'))).toMatch(/model not found/);
  });
});

describe('validateStructured', () => {
  it('accepts JSON matching the schema', () => {
    const result = validateStructured(z.object({ ok: z.boolean() }), '{"ok":true}');
    expect(result.ok).toBe(true);
  });

  it('reports the offending key when the schema does not match', () => {
    const result = validateStructured(z.object({ ok: z.boolean() }), '{"ok":"yes"}');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/ok/);
  });
});
