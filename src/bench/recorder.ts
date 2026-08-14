import type {
  ChatRequest,
  CompletionRequest,
  LLMProvider,
  LLMResult,
  StructuredRequest,
  StructuredResult,
} from '../llm/types.js';
import type { ZodType } from 'zod';

/**
 * An `LLMProvider` that remembers what it spent.
 *
 * A decorator rather than a change to `AnthropicProvider`: the provider is a
 * Phase 0 file, the benchmark is the only caller that needs this, and wrapping
 * means the measured path is exactly the production path — not a copy of it
 * that could drift.
 *
 * Attribution is by call order, not by parsing `meta.purpose`. The benchmark
 * notes `calls.length` before and after each feature and takes the slice
 * between; a purpose string is prose meant for humans and would break the
 * numbers the first time someone reworded it.
 */

export interface RecordedCall {
  stage: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export class RecordingProvider implements LLMProvider {
  readonly calls: RecordedCall[] = [];

  constructor(private readonly inner: LLMProvider) {}

  async complete(req: CompletionRequest): Promise<LLMResult> {
    return this.record(req.meta.stage, await this.inner.complete(req));
  }

  async chat(req: ChatRequest): Promise<LLMResult> {
    return this.record(req.meta.stage, await this.inner.chat(req));
  }

  async structured<T>(schema: ZodType<T>, req: StructuredRequest): Promise<StructuredResult<T>> {
    const result = await this.inner.structured(schema, req);
    this.push(req.meta.stage, result.model, result.usage, result.latencyMs);
    return result;
  }

  /** Usage since a mark, for per-feature attribution. */
  since(mark: number): RecordedCall[] {
    return this.calls.slice(mark);
  }

  /** Where the next call will land. Take this before a stage, pass it to `since`. */
  mark(): number {
    return this.calls.length;
  }

  private record(stage: string, result: LLMResult): LLMResult {
    this.push(stage, result.model, result.usage, result.latencyMs);
    return result;
  }

  private push(
    stage: string,
    model: string,
    usage: { inputTokens: number; outputTokens: number },
    latencyMs: number,
  ): void {
    this.calls.push({
      stage,
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      latencyMs,
    });
  }
}

export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  /** Models involved, sorted — a run can mix planner and repair models. */
  models: string[];
}

export function totalUsage(calls: readonly RecordedCall[]): UsageTotals {
  return {
    calls: calls.length,
    inputTokens: calls.reduce((sum, c) => sum + c.inputTokens, 0),
    outputTokens: calls.reduce((sum, c) => sum + c.outputTokens, 0),
    latencyMs: calls.reduce((sum, c) => sum + c.latencyMs, 0),
    models: [...new Set(calls.map((c) => c.model))].sort(),
  };
}
