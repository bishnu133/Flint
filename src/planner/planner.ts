import { TestPlanSchema, type TestPlan } from '../schemas/test-plan.js';
import { FlintError as FlintErrorClass, StructuredOutputError } from '../shared/errors.js';
import type { ScreenModel } from '../schemas/screen-model.js';
import type { SuiteIndex } from '../schemas/suite-index.js';
import type { LLMProvider } from '../llm/types.js';
import { loadAndRender } from '../generator/template-loader.js';
import { FlintError } from '../shared/errors.js';
import { silentLogger, type Logger } from '../shared/logger.js';
import { formatZodError } from '../shared/zod-format.js';
import type { FeatureSpec } from './feature-spec.js';
import { buildContext, type ExemplarFile } from './context-builder.js';
import {
  applyDuplicateDetection,
  checkElementRefs,
  formatReferentialReport,
  type DuplicateDecision,
} from './plan-validator.js';

/**
 * Stage A — feature spec to TestPlan.
 *
 * The LLM is bounded on both sides. Going in, it sees only element ids that
 * exist and have a verified selector. Coming out, the plan is zod-validated,
 * every reference is re-checked against those ids, and duplicate detection is
 * re-run deterministically rather than trusted.
 *
 * One retry on a malformed plan, with the validation error fed back. Beyond
 * that it fails loudly: a second failure means something is wrong with the
 * prompt or the model, and silently returning a half-plan would put invented
 * tests in front of a human wearing the authority of the tool.
 */

export interface PlanOptions {
  spec: FeatureSpec;
  model: ScreenModel;
  provider: LLMProvider;
  /** Model id from `config.models.planner`. */
  modelId: string;
  index?: SuiteIndex;
  conventions?: string;
  exemplars?: ExemplarFile[];
  /** `config.tokenBudgets.plan`. */
  tokenBudget: number;
  logger?: Logger;
}

export interface PlanResult {
  plan: TestPlan;
  /** Cases forced to `skipped-duplicate` by the deterministic post-check. */
  forcedDuplicates: DuplicateDecision[];
  /** Context sections dropped to fit the token budget. */
  droppedContext: string[];
  estimatedPromptTokens: number;
  /** True when the first attempt produced an invalid plan and a retry was used. */
  retried: boolean;
}

const MAX_ATTEMPTS = 2;

export async function generatePlan(options: PlanOptions): Promise<PlanResult> {
  const logger = options.logger ?? silentLogger();
  const { spec, model } = options;

  const context = buildContext({
    spec,
    model,
    tokenBudget: options.tokenBudget,
    ...(options.index !== undefined ? { index: options.index } : {}),
    ...(options.conventions !== undefined ? { conventions: options.conventions } : {}),
    ...(options.exemplars !== undefined ? { exemplars: options.exemplars } : {}),
  });

  if (context.dropped.length > 0) {
    logger.warn(
      { dropped: context.dropped, budget: options.tokenBudget },
      'plan: context truncated to fit the token budget',
    );
  }

  const rendered = loadAndRender('plan-stage-a', {
    context: context.text,
    featureId: spec.frontmatter.id,
    screenModelVersion: model.version,
  });
  const prompt = rendered.text;
  logger.debug(
    { template: rendered.template.name, version: rendered.template.version },
    'plan: prompt template loaded',
  );

  let lastError: string | undefined;
  let retried = false;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const attemptPrompt =
      lastError === undefined ? prompt : `${prompt}\n\n${retryNotice(lastError)}`;

    const result = await options.provider
      .structured(TestPlanSchema, {
        model: options.modelId,
        prompt: attemptPrompt,
        // Planning is not code emission, but a stable plan makes the whole
        // pipeline reproducible, so temperature 0 here too.
        temperature: 0,
        meta: { stage: 'plan', purpose: `feature "${spec.frontmatter.id}" -> test plan` },
      })
      .catch((err: unknown) => {
        // A transport, auth or budget failure is not something a retry can
        // fix, and calling it "an invalid plan from the model" hides the real
        // cause. Only a schema mismatch — the model wrote the wrong shape — is
        // worth another attempt with the error fed back.
        if (!(err instanceof StructuredOutputError)) throw relayProviderFailure(err);
        lastError = describeError(err);
        return undefined;
      });

    if (result === undefined) {
      retried = attempt < MAX_ATTEMPTS;
      logger.warn({ attempt, err: lastError }, 'plan: invalid plan from the model');
      continue;
    }

    const plan = stampProvenance(result.data, spec.frontmatter.id, model.version);

    const check = checkElementRefs(plan, context.allowedElementIds);
    if (!check.ok) {
      lastError = formatReferentialReport(check);
      retried = attempt < MAX_ATTEMPTS;
      logger.warn(
        { attempt, unknown: check.unknown.length },
        'plan: plan referenced elements that do not exist',
      );
      if (attempt < MAX_ATTEMPTS) continue;
      // Out of attempts: refuse the plan rather than hand over invented tests.
      throw new FlintError('The generated plan references elements that do not exist.', {
        code: 'PLAN',
        hint: lastError,
      });
    }

    const deduped =
      options.index === undefined
        ? { plan, forced: [] as DuplicateDecision[] }
        : applyDuplicateDetection(plan, options.index);

    logger.info(
      {
        feature: spec.frontmatter.id,
        cases: deduped.plan.cases.length,
        forcedDuplicates: deduped.forced.length,
        tokensIn: result.usage.inputTokens,
        tokensOut: result.usage.outputTokens,
      },
      'plan: generated',
    );

    return {
      plan: deduped.plan,
      forcedDuplicates: deduped.forced,
      droppedContext: context.dropped,
      estimatedPromptTokens: context.estimatedTokens,
      retried,
    };
  }

  throw new FlintError('Could not generate a valid TestPlan after two attempts.', {
    code: 'PLAN',
    hint: lastError ?? 'The model returned output that did not match the TestPlan schema.',
  });
}

/**
 * Overwrite the three plan fields that are facts about the run, not judgements
 * about the feature.
 *
 * A language model has no clock and no view of the run, so `generatedAt` came
 * back as a plausible-looking invention — a real plan generated on 2026-08-12
 * was stamped `2026-01-13T00:00:00.000Z`. Anything downstream that reasons
 * about plan age (staleness against the Screen Model, "was this re-planned
 * after the crawl") would be reading fiction. The prompt still asks for the
 * fields so the schema validates on the first attempt; the values are ours.
 */
function stampProvenance(plan: TestPlan, featureId: string, screenModelVersion: string): TestPlan {
  return {
    ...plan,
    featureId,
    screenModelVersion,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Re-throw a provider failure with its diagnosis intact.
 *
 * `AnthropicProvider` puts the actionable half in `hint` — the cause chain,
 * the Node error code, and advice such as which proxy variable to set. Relaying
 * only `err.message` reduces a diagnosable TLS or auth problem to the useless
 * line "Anthropic API call failed", which is exactly the failure this project
 * built `describeRequestFailure` to avoid.
 */
function relayProviderFailure(err: unknown): Error {
  if (err instanceof FlintErrorClass) return err;
  return new FlintError('The planner could not reach the model.', {
    code: 'PLAN',
    cause: err,
    hint: err instanceof Error ? err.message : String(err),
  });
}

/** Message plus hint, so a retry sees everything a human would. */
function describeError(err: unknown): string {
  if (err instanceof FlintErrorClass) {
    return err.hint === undefined ? err.message : `${err.message} ${err.hint}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Fed back verbatim on the retry — the model fixes what it can see. */
function retryNotice(error: string): string {
  return [
    '# Your previous answer was rejected',
    '',
    'Fix exactly this and return the corrected JSON object, nothing else:',
    '',
    error,
  ].join('\n');
}

/** Re-export so callers validate stored plans through one path. */
export function parsePlan(raw: unknown, source: string): TestPlan {
  const parsed = TestPlanSchema.safeParse(raw);
  if (!parsed.success) {
    throw new FlintError(
      `TestPlan failed validation (${source}):\n${formatZodError(parsed.error)}`,
      {
        code: 'PLAN',
        hint: 'Delete it and re-run `flint plan`.',
      },
    );
  }
  return parsed.data;
}
