import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
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

  it('rejects record mode without a delegate at construction time', () => {
    expect(() => new FakeProvider({ record: true, fixtureDir: '/tmp/x' })).toThrow(
      /record mode requires a delegate/,
    );
  });

  it('rejects record mode without a fixtureDir at construction time', () => {
    const delegate = {
      complete: async () => {
        throw new Error('must never be called');
      },
      chat: async () => {
        throw new Error('unused');
      },
      structured: async () => {
        throw new Error('unused');
      },
    };
    expect(() => new FakeProvider({ record: true, delegate })).toThrow(
      /record mode requires a fixtureDir/,
    );
  });

  it('reports a corrupt fixture file with an actionable error naming the file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flint-fixtures-bad-'));
    const key = FakeProvider.keyFor({
      method: 'complete',
      model: 'fake-model',
      purpose: meta.purpose,
      payload: 'broken',
    });
    writeFileSync(join(dir, `${key}.json`), '{not json', 'utf8');
    const provider = new FakeProvider({ fixtureDir: dir });
    await expect(provider.complete(completionReq('broken'))).rejects.toThrow(
      /fixture file is not valid JSON.*\.json/,
    );
  });

  it('reports a fixture file with a wrong shape (missing text)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flint-fixtures-shape-'));
    const key = FakeProvider.keyFor({
      method: 'complete',
      model: 'fake-model',
      purpose: meta.purpose,
      payload: 'shapeless',
    });
    writeFileSync(join(dir, `${key}.json`), '{"usage": {"inputTokens": 1}}', 'utf8');
    const provider = new FakeProvider({ fixtureDir: dir });
    await expect(provider.complete(completionReq('shapeless'))).rejects.toThrow(
      /invalid shape.*missing string "text"/,
    );
  });

  it('records to a fixture dir then replays it offline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flint-fixtures-'));
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
