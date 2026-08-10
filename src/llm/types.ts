import type { ZodType } from 'zod';

/**
 * LLMProvider interface + shared request/response types.
 *
 * All stages call the LLM through this interface (never the SDK directly) so
 * OpenAI or others can slot in later, and so every call flows through one call
 * logger. Structured output is zod-validated — the contract that keeps the
 * pipeline's I/O safe.
 */

export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/** Stage + purpose recorded with every call for the call logger. */
export interface CallMeta {
  /** Pipeline stage, e.g. 'plan', 'generate', 'repair', 'smoke'. */
  stage: string;
  /** Human-readable purpose, e.g. 'feature-spec -> test plan'. */
  purpose: string;
}

interface BaseRequest {
  model: string;
  system?: string;
  maxTokens?: number;
  /** Defaults: 0 for structured/emit (determinism), provider default otherwise. */
  temperature?: number;
  meta: CallMeta;
}

export interface CompletionRequest extends BaseRequest {
  prompt: string;
}

export interface ChatRequest extends BaseRequest {
  messages: ChatMessage[];
}

export interface StructuredRequest extends BaseRequest {
  prompt: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LLMResult {
  text: string;
  model: string;
  usage: TokenUsage;
  latencyMs: number;
  stopReason?: string;
}

export interface StructuredResult<T> {
  data: T;
  raw: string;
  model: string;
  usage: TokenUsage;
  latencyMs: number;
}

export interface LLMProvider {
  complete(req: CompletionRequest): Promise<LLMResult>;
  chat(req: ChatRequest): Promise<LLMResult>;
  structured<T>(schema: ZodType<T>, req: StructuredRequest): Promise<StructuredResult<T>>;
}
