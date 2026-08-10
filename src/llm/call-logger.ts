import type { Logger } from '../shared/logger.js';
import type { CallMeta, TokenUsage } from './types.js';

/**
 * Structured logging for every LLM call.
 *
 * Logs stage, purpose, model, token counts, and latency (master plan B1).
 * Raw prompts are logged ONLY when `logPrompts` is true — prompts may contain
 * secrets, so this defaults off.
 */
export interface CallLogFields {
  method: 'complete' | 'chat' | 'structured';
  model: string;
  meta: CallMeta;
  usage: TokenUsage;
  latencyMs: number;
  stopReason?: string;
}

export function logCall(
  logger: Logger,
  fields: CallLogFields,
  options: { logPrompts?: boolean; prompt?: string } = {},
): void {
  const base = {
    llm: fields.method,
    stage: fields.meta.stage,
    purpose: fields.meta.purpose,
    model: fields.model,
    inputTokens: fields.usage.inputTokens,
    outputTokens: fields.usage.outputTokens,
    latencyMs: fields.latencyMs,
    stopReason: fields.stopReason,
  };
  if (options.logPrompts && options.prompt !== undefined) {
    logger.debug({ ...base, prompt: options.prompt }, 'llm call');
  } else {
    logger.info(base, 'llm call');
  }
}
