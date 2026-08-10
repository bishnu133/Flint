import { describe, it, expect } from 'vitest';
import { pino } from 'pino';
import { Writable } from 'node:stream';
import { logCall } from './call-logger.js';

function captureLogger(level: 'info' | 'debug') {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(JSON.parse(String(chunk)) as Record<string, unknown>);
      cb();
    },
  });
  return { logger: pino({ level, base: undefined }, stream), lines };
}

const fields = {
  method: 'structured' as const,
  model: 'test-model',
  meta: { stage: 'plan', purpose: 'unit' },
  usage: { inputTokens: 12, outputTokens: 3 },
  latencyMs: 42,
};

describe('logCall', () => {
  it('always emits the call record at info level, even with logPrompts on', () => {
    const { logger, lines } = captureLogger('info');
    logCall(logger, fields, { logPrompts: true, prompt: 'secret prompt' });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.stage).toBe('plan');
    expect(lines[0]?.inputTokens).toBe(12);
    expect(lines[0]?.prompt).toBe('secret prompt');
  });

  it('never includes the prompt when logPrompts is off', () => {
    const { logger, lines } = captureLogger('info');
    logCall(logger, fields, { logPrompts: false, prompt: 'secret prompt' });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.prompt).toBeUndefined();
    expect(lines[0]?.latencyMs).toBe(42);
  });
});
