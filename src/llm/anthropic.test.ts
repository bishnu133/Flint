import { describe, it, expect } from 'vitest';
import {
  AnthropicProvider,
  describeRequestFailure,
  isTemperatureRejection,
  validateStructured,
} from './anthropic.js';
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

describe('isTemperatureRejection', () => {
  it('recognises the deprecation error the API returns for newer models', () => {
    // Verbatim shape from a real 400 against claude-opus-5.
    expect(
      isTemperatureRejection(
        new Error(
          '400 {"type":"error","error":{"type":"invalid_request_error","message":"`temperature` is deprecated for this model."}}',
        ),
      ),
    ).toBe(true);
  });

  it('recognises a not-supported wording too', () => {
    expect(isTemperatureRejection(new Error('temperature is not supported'))).toBe(true);
  });

  it('does not trigger on unrelated 400s', () => {
    expect(isTemperatureRejection(new Error('400 max_tokens is too large'))).toBe(false);
    expect(isTemperatureRejection(new Error('deprecated model'))).toBe(false);
  });
});

describe('AnthropicProvider temperature fallback', () => {
  interface Call {
    temperature?: number;
  }

  /** Provider with a stubbed SDK client that rejects temperature like Opus 5. */
  function providerRejectingTemperature(): { provider: AnthropicProvider; calls: Call[] } {
    const provider = new AnthropicProvider({ apiKey: 'test-key' });
    const calls: Call[] = [];
    const fakeCreate = (params: { temperature?: number }): Promise<unknown> => {
      calls.push({
        ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
      });
      if (params.temperature !== undefined) {
        return Promise.reject(
          new Error(
            '400 {"type":"error","error":{"type":"invalid_request_error","message":"`temperature` is deprecated for this model."}}',
          ),
        );
      }
      return Promise.resolve({
        model: 'claude-opus-5',
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: 'text', text: 'ok' }],
      });
    };
    // why: reach into the private client to stub the SDK boundary — the whole
    // point is testing our wrapper, not Anthropic's transport.
    (provider as unknown as { client: { messages: { create: typeof fakeCreate } } }).client = {
      messages: { create: fakeCreate },
    };
    return { provider, calls };
  }

  it('drops temperature after a rejection and remembers the model', async () => {
    const { provider, calls } = providerRejectingTemperature();
    const meta = { stage: 'test', purpose: 'temperature fallback' };

    const first = await provider.complete({
      model: 'claude-opus-5',
      prompt: 'hi',
      temperature: 0,
      meta,
    });
    expect(first.text).toBe('ok');
    // Attempt with temperature, rejection, retry without.
    expect(calls).toEqual([{ temperature: 0 }, {}]);

    await provider.complete({ model: 'claude-opus-5', prompt: 'again', temperature: 0, meta });
    // Learned: no second rejection round-trip.
    expect(calls).toHaveLength(3);
    expect(calls[2]).toEqual({});
  });

  it('does not mask an unrelated 400 as a temperature problem', async () => {
    const provider = new AnthropicProvider({ apiKey: 'test-key' });
    (provider as unknown as { client: { messages: { create: () => Promise<never> } } }).client = {
      messages: { create: () => Promise.reject(new Error('400 max_tokens is too large')) },
    };
    await expect(
      provider.complete({
        model: 'claude-opus-5',
        prompt: 'hi',
        temperature: 0,
        meta: { stage: 'test', purpose: 'unrelated 400' },
      }),
    ).rejects.toThrow(/Anthropic API call failed/);
  });
});
