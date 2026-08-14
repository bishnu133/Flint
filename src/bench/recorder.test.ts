import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { RecordingProvider, totalUsage } from './recorder.js';
import type { LLMProvider, LLMResult, StructuredResult } from '../llm/types.js';

/**
 * The recorder wraps the real provider so the measured path is the production
 * path. These pin that it records every call shape and stays out of the way.
 */

const fake: LLMProvider = {
  complete: async () => result('completed'),
  chat: async () => result('chatted'),
  structured: async <T>() =>
    ({
      data: { ok: true } as T,
      raw: '{"ok":true}',
      model: 'claude-opus-5',
      usage: { inputTokens: 300, outputTokens: 40 },
      latencyMs: 30,
    }) as StructuredResult<T>,
};

function result(text: string): LLMResult {
  return {
    text,
    model: 'claude-opus-5',
    usage: { inputTokens: 100, outputTokens: 20 },
    latencyMs: 10,
  };
}

const meta = { stage: 'plan', purpose: 'test' };

describe('RecordingProvider', () => {
  it('records every call shape', async () => {
    const provider = new RecordingProvider(fake);
    await provider.complete({ model: 'm', prompt: 'p', meta });
    await provider.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], meta });
    await provider.structured(z.object({ ok: z.boolean() }), { model: 'm', prompt: 'p', meta });
    expect(provider.calls).toHaveLength(3);
    expect(totalUsage(provider.calls).inputTokens).toBe(500);
  });

  it('passes the result through untouched', async () => {
    const provider = new RecordingProvider(fake);
    expect((await provider.complete({ model: 'm', prompt: 'p', meta })).text).toBe('completed');
  });

  it('slices calls by mark, so per-feature attribution needs no prose parsing', async () => {
    // Purpose strings are prose for humans; keying numbers off them would break
    // the first time someone reworded one.
    const provider = new RecordingProvider(fake);
    await provider.complete({ model: 'm', prompt: 'a', meta });
    const mark = provider.mark();
    await provider.complete({ model: 'm', prompt: 'b', meta });
    await provider.complete({ model: 'm', prompt: 'c', meta });
    expect(provider.since(mark)).toHaveLength(2);
  });

  it('reports the models a run touched', async () => {
    const provider = new RecordingProvider(fake);
    await provider.complete({ model: 'm', prompt: 'p', meta });
    expect(totalUsage(provider.calls).models).toEqual(['claude-opus-5']);
  });

  it('totals an empty run to zero without dividing by anything', () => {
    expect(totalUsage([])).toEqual({
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      models: [],
    });
  });
});
