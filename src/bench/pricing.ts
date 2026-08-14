/**
 * Model pricing, for the benchmark's cost-per-feature metric.
 *
 * These numbers are **quoted, not remembered.** They come from the Anthropic
 * pricing table as of 2026-06-24, checked at the time this file was written
 * rather than recalled — a benchmark whose cost column is a guess is worse than
 * one with no cost column, because a wrong number still gets pasted into a
 * business case.
 *
 * That is also why every figure carries `asOf`: a price is a fact with a date,
 * and the report prints the date next to the number so a stale table announces
 * itself instead of quietly misinforming.
 *
 * Prices are US dollars per **million** tokens.
 */

export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  /** When this figure was last checked against the published table. */
  asOf: string;
  /** Set when the price in force is promotional and will change. */
  note?: string;
}

const PRICING: Record<string, ModelPrice> = {
  'claude-opus-5': { inputPerMTok: 5.0, outputPerMTok: 25.0, asOf: '2026-06-24' },
  'claude-fable-5': { inputPerMTok: 10.0, outputPerMTok: 50.0, asOf: '2026-06-24' },
  'claude-sonnet-5': {
    inputPerMTok: 2.0,
    outputPerMTok: 10.0,
    asOf: '2026-06-24',
    note: 'introductory rate through 2026-08-31; list price is $3.00 / $15.00',
  },
  'claude-sonnet-4-6': { inputPerMTok: 3.0, outputPerMTok: 15.0, asOf: '2026-06-24' },
  'claude-opus-4-8': { inputPerMTok: 5.0, outputPerMTok: 25.0, asOf: '2026-06-24' },
  'claude-haiku-4-5': { inputPerMTok: 1.0, outputPerMTok: 5.0, asOf: '2026-06-24' },
};

export interface CostEstimate {
  usd: number;
  /** False when the model is not in the table — the caller must say so. */
  priced: boolean;
  price?: ModelPrice;
}

/**
 * Cost of one model's usage.
 *
 * An unknown model returns `priced: false` rather than zero. Zero would be a
 * lie that sums silently into a total; the report prints "unpriced" instead.
 */
export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): CostEstimate {
  const price = PRICING[model];
  if (price === undefined) return { usd: 0, priced: false };
  return {
    usd:
      (inputTokens / 1_000_000) * price.inputPerMTok +
      (outputTokens / 1_000_000) * price.outputPerMTok,
    priced: true,
    price,
  };
}

/** The models this table knows, for the report's footnote. */
export function pricedModels(): string[] {
  return Object.keys(PRICING).sort();
}

export function priceOf(model: string): ModelPrice | undefined {
  return PRICING[model];
}

/** Dollars, at a precision that does not pretend to more accuracy than it has. */
export function formatUsd(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}
