import Anthropic from '@anthropic-ai/sdk';
import type { ZodType } from 'zod';
import { ProviderError, StructuredOutputError } from '../shared/errors.js';
import { formatZodError } from '../shared/zod-format.js';
import { createLogger, type Logger } from '../shared/logger.js';
import { logCall } from './call-logger.js';
import { parseJsonLoose } from './json.js';
import type {
  ChatRequest,
  CompletionRequest,
  LLMProvider,
  LLMResult,
  StructuredRequest,
  StructuredResult,
  TokenUsage,
} from './types.js';

const DEFAULT_MAX_TOKENS = 4096;

export interface AnthropicProviderOptions {
  /** Overrides the ANTHROPIC_API_KEY env var. */
  apiKey?: string;
  logger?: Logger;
  /** Log raw prompts (default false — prompts may contain secrets). */
  logPrompts?: boolean;
}

/**
 * Anthropic implementation of {@link LLMProvider}.
 *
 * Throws an actionable {@link ProviderError} naming ANTHROPIC_API_KEY when no
 * key is available, so `testgen hello-llm` fails with guidance, not a stack
 * trace. Never called from tests (FakeProvider only).
 */
export class AnthropicProvider implements LLMProvider {
  private readonly client: Anthropic;
  private readonly logger: Logger;
  private readonly logPrompts: boolean;

  constructor(options: AnthropicProviderOptions = {}) {
    const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (apiKey === undefined || apiKey.trim() === '') {
      throw new ProviderError('ANTHROPIC_API_KEY is not set.', {
        hint: 'Export your Anthropic API key: export ANTHROPIC_API_KEY=sk-ant-...',
      });
    }
    this.client = new Anthropic({ apiKey });
    this.logger = options.logger ?? createLogger();
    this.logPrompts = options.logPrompts ?? false;
  }

  async complete(req: CompletionRequest): Promise<LLMResult> {
    return this.callMessages(
      'complete',
      {
        model: req.model,
        system: req.system,
        maxTokens: req.maxTokens,
        temperature: req.temperature,
        messages: [{ role: 'user', content: req.prompt }],
      },
      req.meta,
      req.prompt,
    );
  }

  async chat(req: ChatRequest): Promise<LLMResult> {
    return this.callMessages(
      'chat',
      {
        model: req.model,
        system: req.system,
        maxTokens: req.maxTokens,
        temperature: req.temperature,
        messages: req.messages,
      },
      req.meta,
      req.messages.map((m) => `${m.role}: ${m.content}`).join('\n'),
    );
  }

  async structured<T>(schema: ZodType<T>, req: StructuredRequest): Promise<StructuredResult<T>> {
    const system = [
      req.system,
      'Respond with a single valid JSON value only. No prose, no code fences.',
    ]
      .filter(Boolean)
      .join('\n\n');

    // Temperature 0 by default for structured output (determinism).
    const temperature = req.temperature ?? 0;

    let lastError: string | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const prompt =
        attempt === 0
          ? req.prompt
          : `${req.prompt}\n\nYour previous response failed validation:\n${lastError}\nReturn corrected JSON only.`;

      const result = await this.callMessages(
        'structured',
        {
          model: req.model,
          system,
          maxTokens: req.maxTokens,
          temperature,
          messages: [{ role: 'user', content: prompt }],
        },
        req.meta,
        prompt,
      );

      const validated = validateStructured(schema, result.text);
      if (validated.ok) {
        return {
          data: validated.data,
          raw: result.text,
          model: result.model,
          usage: result.usage,
          latencyMs: result.latencyMs,
        };
      }
      lastError = validated.error;
    }

    throw new StructuredOutputError(
      `Model output failed schema validation after 2 attempts (stage: ${req.meta.stage}).`,
      { hint: lastError },
    );
  }

  private async callMessages(
    method: 'complete' | 'chat' | 'structured',
    params: {
      model: string;
      system?: string;
      maxTokens?: number;
      temperature?: number;
      messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    },
    meta: { stage: string; purpose: string },
    promptForLog: string,
  ): Promise<LLMResult> {
    const started = Date.now();
    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create({
        model: params.model,
        max_tokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
        ...(params.system !== undefined ? { system: params.system } : {}),
        messages: params.messages,
      });
    } catch (err) {
      throw new ProviderError(`Anthropic API call failed (stage: ${meta.stage}).`, {
        cause: err,
        hint: err instanceof Error ? err.message : undefined,
      });
    }
    const latencyMs = Date.now() - started;
    const text = extractText(response);
    const usage: TokenUsage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
    logCall(
      this.logger,
      {
        method,
        model: response.model,
        meta,
        usage,
        latencyMs,
        stopReason: response.stop_reason ?? undefined,
      },
      { logPrompts: this.logPrompts, prompt: promptForLog },
    );
    return {
      text,
      model: response.model,
      usage,
      latencyMs,
      stopReason: response.stop_reason ?? undefined,
    };
  }
}

function extractText(response: Anthropic.Message): string {
  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/** Shared structured-validation used by any provider. */
export function validateStructured<T>(
  schema: ZodType<T>,
  raw: string,
): { ok: true; data: T } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = parseJsonLoose(raw);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'invalid JSON' };
  }
  const parsed = schema.safeParse(json);
  if (parsed.success) {
    return { ok: true, data: parsed.data };
  }
  return { ok: false, error: formatZodError(parsed.error) };
}
