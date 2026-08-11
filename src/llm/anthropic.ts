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
 * key is available, so `flint hello-llm` fails with guidance, not a stack
 * trace. Never called from tests (FakeProvider only).
 */
export class AnthropicProvider implements LLMProvider {
  private readonly client: Anthropic;
  private readonly logger: Logger;
  private readonly logPrompts: boolean;
  /** Models that rejected `temperature` — learned at runtime, never guessed. */
  private readonly noTemperature = new Set<string>();

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

      if (result.stopReason === 'max_tokens') {
        throw new ProviderError(
          `Model output was truncated at ${req.maxTokens ?? DEFAULT_MAX_TOKENS} output tokens (stage: ${req.meta.stage}) — the JSON is incomplete.`,
          {
            hint: 'Raise maxTokens for this call (see tokenBudgets in flint.config.ts) or shrink the prompt.',
          },
        );
      }

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
    const request = (withTemperature: boolean): Anthropic.MessageCreateParamsNonStreaming => ({
      model: params.model,
      max_tokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(withTemperature && params.temperature !== undefined
        ? { temperature: params.temperature }
        : {}),
      ...(params.system !== undefined ? { system: params.system } : {}),
      messages: params.messages,
    });

    let response: Anthropic.Message;
    try {
      const sendTemperature = !this.noTemperature.has(params.model);
      try {
        response = await this.client.messages.create(request(sendTemperature));
      } catch (err) {
        // Newer models reject the temperature parameter outright
        // ("`temperature` is deprecated for this model"). The model id is the
        // user's choice in flint.config.ts, so a hardcoded list would rot;
        // instead, learn from the rejection, drop the parameter, and retry
        // once. The model is remembered so later calls skip it up front.
        if (!(sendTemperature && params.temperature !== undefined && isTemperatureRejection(err))) {
          throw err;
        }
        this.noTemperature.add(params.model);
        this.logger.warn(
          { model: params.model },
          'model rejects the temperature parameter — retrying without it',
        );
        response = await this.client.messages.create(request(false));
      }
    } catch (err) {
      throw new ProviderError(`Anthropic API call failed (stage: ${meta.stage}).`, {
        cause: err,
        hint: describeRequestFailure(err),
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

/** Node network error codes mapped to the thing the user should actually check. */
const NETWORK_CAUSE_HINTS: Readonly<Record<string, string>> = Object.freeze({
  ENOTFOUND:
    'DNS could not resolve the host. Check your DNS/VPN, or whether a proxy is required on this network.',
  EAI_AGAIN: 'DNS lookup timed out. Check your DNS resolver or VPN connection.',
  ECONNREFUSED: 'The connection was refused. If you are behind a corporate proxy, set HTTPS_PROXY.',
  ECONNRESET: 'The connection was reset mid-request — often a firewall or TLS-inspecting proxy.',
  ETIMEDOUT: 'The connection timed out. A firewall may be dropping traffic to api.anthropic.com.',
  UND_ERR_CONNECT_TIMEOUT:
    'The connection timed out. A firewall may be dropping traffic to api.anthropic.com.',
  EPROTO: 'TLS handshake failed — often a TLS-inspecting proxy with an untrusted certificate.',
  CERT_HAS_EXPIRED: 'The TLS certificate presented is expired (likely a TLS-inspecting proxy).',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE:
    'The TLS certificate could not be verified — likely a corporate TLS-inspecting proxy. Point NODE_EXTRA_CA_CERTS at your CA bundle.',
  SELF_SIGNED_CERT_IN_CHAIN:
    'A self-signed certificate is in the chain — likely a corporate TLS-inspecting proxy. Point NODE_EXTRA_CA_CERTS at your CA bundle.',
});

/**
 * Build an actionable hint from a failed SDK request.
 *
 * The Anthropic SDK surfaces network failures as a bare "Connection error.",
 * which tells the user nothing. The real reason (DNS, refused, TLS, proxy) is
 * carried on the error's `cause` chain, so we walk it and name what to check.
 */
/** Does this API error say the model refuses the temperature parameter? */
export function isTemperatureRejection(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /temperature/i.test(message) && /(deprecated|not supported|unsupported)/i.test(message);
}

export function describeRequestFailure(err: unknown): string | undefined {
  const parts: string[] = [];
  const top = err instanceof Error ? err.message : String(err);
  if (top) parts.push(top);

  for (const link of causeChain(err)) {
    const code = errorCode(link);
    const detail = [code, link.message].filter(Boolean).join(': ');
    if (detail && !parts.includes(detail)) parts.push(detail);
    const advice = code === undefined ? undefined : NETWORK_CAUSE_HINTS[code];
    if (advice !== undefined) {
      parts.push(advice);
      break;
    }
  }

  // A bare "Connection error." with no diagnosable cause is still worth guiding.
  if (parts.length === 1 && /connection error/i.test(top)) {
    parts.push(
      'Could not reach api.anthropic.com. Check network access, and set HTTPS_PROXY if you are behind a proxy. Verify with: curl -sS -o /dev/null -w "%{http_code}\\n" https://api.anthropic.com/v1/messages',
    );
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/** Walk an error's `cause` chain (bounded, cycle-safe). */
function causeChain(err: unknown): Error[] {
  const chain: Error[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err instanceof Error ? err.cause : undefined;
  while (current instanceof Error && !seen.has(current) && chain.length < 10) {
    seen.add(current);
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

/** Node attaches `code`/`errno` to system errors; they are not on the Error type. */
function errorCode(err: Error): string | undefined {
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
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
