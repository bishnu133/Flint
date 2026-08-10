import type { Command } from 'commander';
import { z } from 'zod';
import { loadAndRender } from '../../generator/template-loader.js';
import { promptsDir } from '../../shared/paths.js';
import { createLogger } from '../../shared/logger.js';

/** Default smoke-test model; override with --model or ANTHROPIC_MODEL. */
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5';

const HelloSchema = z.object({
  greeting: z.string().min(1),
  ok: z.literal(true),
});

/**
 * `testgen hello-llm` — smoke command proving provider wiring end to end:
 * loads a versioned prompt template, makes one tiny structured call, and prints
 * the model + token counts. Fails with an actionable error naming
 * ANTHROPIC_API_KEY when the key is unset.
 */
export function registerHelloLlm(program: Command): void {
  program
    .command('hello-llm')
    .description('Smoke-test the LLM provider wiring (one tiny structured call)')
    .option('-m, --model <model>', 'model to call', DEFAULT_MODEL)
    .option('-v, --verbose', 'verbose logging', false)
    .action(async (opts: { model: string; verbose: boolean }) => {
      const logger = createLogger({ verbose: opts.verbose });
      // Lazy import so unrelated commands don't load the Anthropic SDK.
      const { AnthropicProvider } = await import('../../llm/anthropic.js');
      const provider = new AnthropicProvider({ logger });

      const { template, text } = loadAndRender('hello-llm', { toolName: 'TestGen' }, promptsDir());

      const result = await provider.structured(HelloSchema, {
        model: opts.model,
        prompt: text,
        meta: { stage: 'smoke', purpose: 'hello-llm' },
      });

      console.log('\nLLM wiring OK');
      console.log(`  prompt template: hello-llm@${template.version}`);
      console.log(`  model:           ${result.model}`);
      console.log(`  input tokens:    ${result.usage.inputTokens}`);
      console.log(`  output tokens:   ${result.usage.outputTokens}`);
      console.log(`  latency:         ${result.latencyMs}ms`);
      console.log(`  greeting:        ${result.data.greeting}`);
    });
}
