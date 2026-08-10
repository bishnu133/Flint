import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ZodType } from 'zod';
import { ProviderError } from '../shared/errors.js';
import { hashValue } from '../shared/hashing.js';
import { silentLogger, type Logger } from '../shared/logger.js';
import { logCall } from './call-logger.js';
import { validateStructured } from './anthropic.js';
import type {
  ChatRequest,
  CompletionRequest,
  LLMProvider,
  LLMResult,
  StructuredRequest,
  StructuredResult,
  TokenUsage,
} from './types.js';

/** A canned response — `text` is returned verbatim (JSON string for structured). */
export interface FakeResponse {
  text: string;
  usage?: TokenUsage;
  stopReason?: string;
}

/** The normalized shape hashed to key a request. Excludes `meta` except purpose. */
interface FakeKeyInput {
  method: 'complete' | 'chat' | 'structured';
  model: string;
  system?: string;
  purpose: string;
  payload: unknown;
}

export interface FakeProviderOptions {
  logger?: Logger;
  logPrompts?: boolean;
  /** Directory for fixture files ({hash}.json). Enables playback and record. */
  fixtureDir?: string;
  /** When true and a delegate is set, real calls are recorded to fixtureDir. */
  record?: boolean;
  /** Real provider used only in record mode. */
  delegate?: LLMProvider;
  /** In-memory canned responses keyed by request hash (see `keyFor`). */
  responses?: Record<string, FakeResponse>;
  /** Fallback responder invoked when no fixture/response matches. */
  responder?: (input: FakeKeyInput) => FakeResponse;
}

const DEFAULT_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0 };

/**
 * Deterministic {@link LLMProvider} for tests.
 *
 * Same request → same response, always. Supports fixture record/playback so
 * integration fixtures can be captured once against a real provider and replayed
 * offline. No test may hit the real network — this is the only provider tests use.
 */
export class FakeProvider implements LLMProvider {
  private readonly logger: Logger;
  private readonly logPrompts: boolean;
  private readonly options: FakeProviderOptions;

  constructor(options: FakeProviderOptions = {}) {
    this.options = options;
    this.logger = options.logger ?? silentLogger();
    this.logPrompts = options.logPrompts ?? false;
  }

  /** Compute the deterministic fixture/response key for a request shape. */
  static keyFor(input: FakeKeyInput): string {
    return hashValue(input);
  }

  async complete(req: CompletionRequest): Promise<LLMResult> {
    const input: FakeKeyInput = {
      method: 'complete',
      model: req.model,
      system: req.system,
      purpose: req.meta.purpose,
      payload: req.prompt,
    };
    return this.toResult('complete', req, input, (delegate) => delegate.complete(req));
  }

  async chat(req: ChatRequest): Promise<LLMResult> {
    const input: FakeKeyInput = {
      method: 'chat',
      model: req.model,
      system: req.system,
      purpose: req.meta.purpose,
      payload: req.messages,
    };
    return this.toResult('chat', req, input, (delegate) => delegate.chat(req));
  }

  async structured<T>(schema: ZodType<T>, req: StructuredRequest): Promise<StructuredResult<T>> {
    const input: FakeKeyInput = {
      method: 'structured',
      model: req.model,
      system: req.system,
      purpose: req.meta.purpose,
      payload: req.prompt,
    };
    const result = await this.toResult('structured', req, input, async (delegate) => {
      const delegated = await delegate.structured(schema, req);
      return {
        text: delegated.raw,
        model: delegated.model,
        usage: delegated.usage,
        latencyMs: delegated.latencyMs,
      };
    });
    const validated = validateStructured(schema, result.text);
    if (!validated.ok) {
      throw new ProviderError(
        `FakeProvider fixture for purpose "${req.meta.purpose}" is not valid for the schema.`,
        { hint: validated.error },
      );
    }
    return {
      data: validated.data,
      raw: result.text,
      model: result.model,
      usage: result.usage,
      latencyMs: result.latencyMs,
    };
  }

  private async toResult(
    method: 'complete' | 'chat' | 'structured',
    req: { model: string; meta: { stage: string; purpose: string } },
    input: FakeKeyInput,
    callDelegate: (delegate: LLMProvider) => Promise<LLMResult>,
  ): Promise<LLMResult> {
    const key = FakeProvider.keyFor(input);

    // Record mode: call the real provider and persist the fixture.
    if (this.options.record && this.options.delegate) {
      const real = await callDelegate(this.options.delegate);
      this.writeFixture(key, { text: real.text, usage: real.usage, stopReason: real.stopReason });
      return this.logged(method, req, real);
    }

    const canned = this.resolve(key, input);
    if (canned === undefined) {
      throw new ProviderError(
        `No FakeProvider fixture for stage "${req.meta.stage}" / purpose "${req.meta.purpose}" (key ${key}).`,
        {
          hint: 'Register a response, provide a responder, or record fixtures with a real delegate.',
        },
      );
    }
    return this.logged(method, req, {
      text: canned.text,
      model: req.model,
      usage: canned.usage ?? DEFAULT_USAGE,
      latencyMs: 0,
      stopReason: canned.stopReason,
    });
  }

  private resolve(key: string, input: FakeKeyInput): FakeResponse | undefined {
    const inMemory = this.options.responses?.[key];
    if (inMemory !== undefined) return inMemory;

    if (this.options.fixtureDir) {
      const file = join(this.options.fixtureDir, `${key}.json`);
      if (existsSync(file)) {
        return JSON.parse(readFileSync(file, 'utf8')) as FakeResponse;
      }
    }
    if (this.options.responder) return this.options.responder(input);
    return undefined;
  }

  private writeFixture(key: string, response: FakeResponse): void {
    if (!this.options.fixtureDir) {
      throw new ProviderError('FakeProvider record mode requires a fixtureDir.');
    }
    mkdirSync(this.options.fixtureDir, { recursive: true });
    writeFileSync(
      join(this.options.fixtureDir, `${key}.json`),
      `${JSON.stringify(response, null, 2)}\n`,
      'utf8',
    );
  }

  private logged(
    method: 'complete' | 'chat' | 'structured',
    req: { model: string; meta: { stage: string; purpose: string } },
    result: LLMResult,
  ): LLMResult {
    logCall(
      this.logger,
      {
        method,
        model: result.model,
        meta: req.meta,
        usage: result.usage,
        latencyMs: result.latencyMs,
        stopReason: result.stopReason,
      },
      { logPrompts: this.logPrompts },
    );
    return result;
  }
}
