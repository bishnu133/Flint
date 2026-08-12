import { z } from 'zod';
import { classifyFailure } from './classifier.js';
import type { TestResult, TestStatus } from '../schemas/run-report.js';

/**
 * Playwright's JSON reporter, turned into `TestResult`s.
 *
 * A pure function, deliberately: spawning a browser to test the parser would
 * make the most fiddly part of the Verifier the least covered. The spawn lives
 * in `runner.ts` and does nothing but produce the string this file consumes.
 *
 * The shape is validated loosely on purpose. Playwright adds fields between
 * minor versions, and a strict schema here would turn "they upgraded
 * Playwright" into "Flint cannot read your test results" — so unknown fields
 * pass through and only the fields actually read are required.
 */

const AttachmentSchema = z
  .object({ name: z.string().optional(), path: z.string().optional() })
  .passthrough();

const ResultSchema = z
  .object({
    status: z.string().optional(),
    duration: z.number().optional(),
    retry: z.number().optional(),
    error: z
      .object({ message: z.string().optional(), stack: z.string().optional() })
      .passthrough()
      .optional(),
    errors: z
      .array(
        z.object({ message: z.string().optional(), stack: z.string().optional() }).passthrough(),
      )
      .optional(),
    attachments: z.array(AttachmentSchema).optional(),
  })
  .passthrough();

const AnnotationSchema = z.object({ type: z.string() }).passthrough();

const TestSchema = z
  .object({
    status: z.string().optional(),
    expectedStatus: z.string().optional(),
    annotations: z.array(AnnotationSchema).optional(),
    results: z.array(ResultSchema).optional(),
  })
  .passthrough();

const SpecSchema: z.ZodType<SpecNode> = z.lazy(() =>
  z
    .object({
      title: z.string().optional(),
      file: z.string().optional(),
      ok: z.boolean().optional(),
      tests: z.array(TestSchema).optional(),
    })
    .passthrough(),
) as z.ZodType<SpecNode>;

interface SpecNode {
  title?: string;
  file?: string;
  ok?: boolean;
  tests?: Array<z.infer<typeof TestSchema>>;
}

interface SuiteNode {
  title?: string;
  file?: string;
  specs?: SpecNode[];
  suites?: SuiteNode[];
}

const SuiteSchema: z.ZodType<SuiteNode> = z.lazy(() =>
  z
    .object({
      title: z.string().optional(),
      file: z.string().optional(),
      specs: z.array(SpecSchema).optional(),
      suites: z.array(SuiteSchema).optional(),
    })
    .passthrough(),
) as z.ZodType<SuiteNode>;

const ReportSchema = z
  .object({
    suites: z.array(SuiteSchema).optional(),
    errors: z.array(z.object({ message: z.string().optional() }).passthrough()).optional(),
  })
  .passthrough();

export interface ParsedRun {
  tests: TestResult[];
  /**
   * Top-level errors — a spec that failed to compile or a config that threw.
   * These are not test failures; no test ever ran.
   */
  runErrors: string[];
}

/**
 * Parse the reporter's JSON. Throws nothing: a report that cannot be read is
 * reported as a run error rather than an exception, because the caller needs to
 * distinguish "tests failed" from "the run never happened" either way.
 */
export function parsePlaywrightReport(raw: string): ParsedRun {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { tests: [], runErrors: ['Playwright produced output that is not valid JSON'] };
  }

  const parsed = ReportSchema.safeParse(json);
  if (!parsed.success) {
    return { tests: [], runErrors: ['Playwright produced JSON in an unexpected shape'] };
  }

  const tests: TestResult[] = [];
  for (const suite of parsed.data.suites ?? []) collectSuite(suite, undefined, tests);

  // Stable order: the report is written to disk and diffed across runs.
  tests.sort((a, b) => `${a.file}:${a.title}`.localeCompare(`${b.file}:${b.title}`));

  const runErrors = (parsed.data.errors ?? [])
    .map((e) => e.message ?? '')
    .filter((m) => m.trim() !== '');

  return { tests, runErrors };
}

function collectSuite(
  suite: SuiteNode,
  inheritedFile: string | undefined,
  out: TestResult[],
): void {
  const file = suite.file ?? inheritedFile;
  for (const spec of suite.specs ?? []) out.push(...specResults(spec, file));
  for (const child of suite.suites ?? []) collectSuite(child, file, out);
}

function specResults(spec: SpecNode, inheritedFile: string | undefined): TestResult[] {
  const file = spec.file ?? inheritedFile ?? '(unknown file)';
  const title = spec.title ?? '(untitled test)';

  return (spec.tests ?? []).map((test) => {
    const results = test.results ?? [];
    // The last attempt is the outcome; earlier ones are retries.
    const last = results.at(-1);
    const status = mapStatus(test, last);

    const errorText = collectErrorText(last);
    const artifacts = (last?.attachments ?? [])
      .map((a) => a.path)
      .filter((p): p is string => p !== undefined)
      .sort((a, b) => a.localeCompare(b));

    const base: TestResult = {
      title,
      file,
      status,
      // Playwright counts the first attempt as retry 0, so a test that passed
      // on its second run has one repair-free retry behind it. That is the
      // flakiness signal, not a repair attempt — repairs are counted by the
      // repair loop, which has not run yet at parse time.
      repairAttempts: 0,
      ...(last?.duration !== undefined ? { durationMs: Math.max(0, last.duration) } : {}),
      ...(artifacts.length > 0 ? { artifacts } : {}),
    };

    if (status !== 'failed') return base;

    // The LOCKED schema requires a failureClass on every failure.
    const { failureClass } = classifyFailure(errorText);
    return {
      ...base,
      failureClass,
      ...(errorText !== undefined ? { errorExcerpt: excerpt(errorText) } : {}),
    };
  });
}

/**
 * Map Playwright's status vocabulary onto the RunReport's.
 *
 * `fixme` and `skip` both arrive as "skipped"; only the annotation tells them
 * apart, and the difference matters — a fixme is Flint's own marker that the
 * case is blocked, while a skip is usually waiting on setup.
 */
function mapStatus(
  test: { status?: string; annotations?: Array<{ type: string }> },
  last: { status?: string } | undefined,
): TestStatus {
  if (test.status === 'flaky') return 'flaky';
  if (test.status === 'skipped' || last?.status === 'skipped') {
    return (test.annotations ?? []).some((a) => a.type === 'fixme') ? 'fixme' : 'skipped';
  }
  if (test.status === 'expected') return 'passed';
  if (test.status === 'unexpected') return 'failed';
  // Fall back to the attempt itself when the aggregate status is missing.
  if (last?.status === 'passed') return 'passed';
  if (last?.status === 'failed' || last?.status === 'timedOut' || last?.status === 'interrupted') {
    return 'failed';
  }
  return 'failed';
}

/** Message and stack together — Playwright splits the decisive part unevenly. */
function collectErrorText(
  last:
    | {
        error?: { message?: string; stack?: string };
        errors?: Array<{ message?: string; stack?: string }>;
      }
    | undefined,
): string | undefined {
  if (last === undefined) return undefined;
  const parts: string[] = [];
  const push = (e: { message?: string; stack?: string } | undefined): void => {
    if (e === undefined) return;
    if (e.message !== undefined && e.message.trim() !== '') parts.push(e.message);
    if (e.stack !== undefined && e.stack.trim() !== '') parts.push(e.stack);
  };
  push(last.error);
  for (const e of last.errors ?? []) push(e);
  const text = [...new Set(parts)].join('\n').trim();
  return text === '' ? undefined : text;
}

/** Playwright errors can run to hundreds of lines; the head carries the cause. */
const EXCERPT_LINES = 20;

function excerpt(text: string): string {
  // ANSI colour codes survive the JSON reporter and make the report unreadable.
  // eslint-disable-next-line no-control-regex -- why: stripping terminal colour codes needs the escape byte.
  const plain = text.replace(/\[[0-9;]*m/g, '');
  const lines = plain.split('\n');
  return lines.length <= EXCERPT_LINES
    ? plain.trim()
    : `${lines.slice(0, EXCERPT_LINES).join('\n').trim()}\n… (${lines.length - EXCERPT_LINES} more lines)`;
}
