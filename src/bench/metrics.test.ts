import { describe, it, expect } from 'vitest';
import { assembleBench, formatBaseline, pct } from './metrics.js';
import type { RecordedCall } from './recorder.js';

/**
 * The property that makes a baseline worth committing: it never invents a
 * number. A metric that was not measured says so; a model with no published
 * price makes the total absent rather than wrong.
 */

function call(over: Partial<RecordedCall> = {}): RecordedCall {
  return {
    stage: 'plan',
    model: 'claude-opus-5',
    inputTokens: 20_000,
    outputTokens: 4_000,
    latencyMs: 40_000,
    ...over,
  };
}

function feature(over: Partial<Parameters<typeof assembleBench>[0]['features'][number]> = {}) {
  return {
    featureId: 'login',
    cases: 5,
    liveTests: 4,
    degraded: 1,
    compiled: true,
    calls: [call()],
    ...over,
  };
}

function bench(over: Partial<Parameters<typeof assembleBench>[0]> = {}) {
  return assembleBench({
    baseUrl: 'https://www.saucedemo.com',
    features: [feature()],
    stages: [{ stage: 'plan', ms: 40_000 }],
    wallMs: 60_000,
    ranAt: '2026-01-01T00:00:00.000Z',
    ...over,
  });
}

describe('assembleBench', () => {
  it('prices a known model from published rates', () => {
    // 20k in at $5/MTok + 4k out at $25/MTok = $0.10 + $0.10
    expect(bench().features[0]?.costUsd).toBeCloseTo(0.2, 6);
  });

  it('leaves cost absent for a model it has no price for', () => {
    const report = bench({ features: [feature({ calls: [call({ model: 'some-other-model' })] })] });
    expect(report.features[0]?.costUsd).toBeUndefined();
    expect(report.unpricedModels).toEqual(['some-other-model']);
  });

  it('omits the total when any model is unpriced, rather than under-counting', () => {
    // A total that silently drops one model reads as complete and is not.
    const report = bench({
      features: [
        feature({ featureId: 'login' }),
        feature({ featureId: 'cart', calls: [call({ model: 'mystery' })] }),
      ],
    });
    expect(report.totals.costUsd).toBeUndefined();
  });

  it('sums a mixed-model feature when every model is priced', () => {
    const report = bench({
      features: [
        feature({
          calls: [
            call(),
            call({ model: 'claude-haiku-4-5', inputTokens: 1_000_000, outputTokens: 0 }),
          ],
        }),
      ],
    });
    expect(report.features[0]?.costUsd).toBeCloseTo(1.2, 6);
  });

  it('computes compile rate per feature, not as one boolean', () => {
    const report = bench({
      features: [feature({ featureId: 'a' }), feature({ featureId: 'b', compiled: false })],
    });
    expect(report.compileRate).toBe(0.5);
  });

  it('keeps unmeasured rates undefined instead of zero', () => {
    const report = bench();
    expect(report.firstRunPass).toBeUndefined();
    expect(report.postRepairPass).toBeUndefined();
    expect(report.selectorResolveRate).toBeUndefined();
  });

  it('sorts features so a committed baseline diffs cleanly', () => {
    const report = bench({
      features: [feature({ featureId: 'zebra' }), feature({ featureId: 'apple' })],
    });
    expect(report.features.map((f) => f.featureId)).toEqual(['apple', 'zebra']);
  });
});

describe('pct', () => {
  it('says "not measured" rather than 0%', () => {
    expect(pct(undefined)).toBe('not measured');
    expect(pct(0)).toBe('0.0%');
    expect(pct(0.917)).toBe('91.7%');
  });
});

describe('formatBaseline', () => {
  it('leads with the headline metrics', () => {
    const text = formatBaseline(bench({ firstRunPass: 0.75, postRepairPass: 1 }));
    expect(text).toContain('| First-run pass | 75.0% |');
    expect(text).toContain('| Post-repair pass | 100.0% |');
    expect(text).toContain('| Selector re-resolve rate | not measured |');
  });

  it('records the price it used and the date it was checked', () => {
    // A cost figure with no date is a number nobody can audit later.
    const text = formatBaseline(bench());
    expect(text).toContain('claude-opus-5');
    expect(text).toContain('2026-06-24');
  });

  it('names unpriced models instead of hiding them in a total', () => {
    const text = formatBaseline(
      bench({ features: [feature({ calls: [call({ model: 'mystery' })] })] }),
    );
    expect(text).toContain('had no price');
    expect(text).toContain('mystery');
  });
});
