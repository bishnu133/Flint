import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { FakeProvider } from './fake.js';
import type { CompletionRequest, StructuredRequest } from './types.js';

const meta = { stage: 'test', purpose: 'unit' };

function completionReq(prompt: string): CompletionRequest {
  return { model: 'fake-model', prompt, meta };
}

describe('FakeProvider', () => {
  it('is deterministic: same request key produces the same response', async () => {
    const req = completionReq('hello');
    const key = FakeProvider.keyFor({
      method: 'complete',
      model: req.model,
      purpose: meta.purpose,
      payload: 'hello',
    });
    const provider = new FakeProvider({
      responses: { [key]: { text: 'world', usage: { inputTokens: 3, outputTokens: 1 } } },
    });
    const a = await provider.complete(req);
    const b = await provider.complete(req);
    expect(a.text).toBe('world');
    expect(b.text).toBe('world');
    expect(a.usage.inputTokens).toBe(3);
  });

  it('uses a responder fallback when no keyed response matches', async () => {
    const provider = new FakeProvider({
      responder: (input) => ({ text: `echo:${String(input.payload)}` }),
    });
    const result = await provider.complete(completionReq('ping'));
    expect(result.text).toBe('echo:ping');
  });

  it('throws an actionable error when no fixture matches', async () => {
    const provider = new FakeProvider({});
    await expect(provider.complete(completionReq('nope'))).rejects.toThrow(
      /No FakeProvider fixture/,
    );
  });

  it('validates structured output against the schema', async () => {
    const schema = z.object({ ok: z.boolean() });
    const req: StructuredRequest = { model: 'fake-model', prompt: 'give me json', meta };
    const provider = new FakeProvider({
      responder: () => ({ text: '{"ok": true}' }),
    });
    const result = await provider.structured(schema, req);
    expect(result.data.ok).toBe(true);
  });

  it('rejects a structured fixture that does not match the schema', async () => {
    const schema = z.object({ ok: z.boolean() });
    const req: StructuredRequest = { model: 'fake-model', prompt: 'give me json', meta };
    const provider = new FakeProvider({
      responder: () => ({ text: '{"ok": "yes"}' }),
    });
    await expect(provider.structured(schema, req)).rejects.toThrow(/not valid for the schema/);
  });

  it('records to a fixture dir then replays it offline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'testgen-fixtures-'));
    const delegate = {
      complete: async () => ({
        text: 'recorded',
        model: 'real-model',
        usage: { inputTokens: 10, outputTokens: 2 },
        latencyMs: 5,
      }),
      chat: async () => {
        throw new Error('unused');
      },
      structured: async () => {
        throw new Error('unused');
      },
    };
    const recorder = new FakeProvider({ fixtureDir: dir, record: true, delegate });
    const recorded = await recorder.complete(completionReq('capture me'));
    expect(recorded.text).toBe('recorded');

    const key = FakeProvider.keyFor({
      method: 'complete',
      model: 'fake-model',
      purpose: meta.purpose,
      payload: 'capture me',
    });
    expect(existsSync(join(dir, `${key}.json`))).toBe(true);

    // Playback with no delegate — proves offline replay.
    const player = new FakeProvider({ fixtureDir: dir });
    const replayed = await player.complete(completionReq('capture me'));
    expect(replayed.text).toBe('recorded');
  });
});
