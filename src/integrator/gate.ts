import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import type { WriteDecision } from './writer.js';
import { silentLogger, type Logger } from '../shared/logger.js';

/**
 * The compile gate: generated code is typechecked BEFORE it reaches the suite.
 *
 * The master plan's exit criterion is "compiles clean 100%". A gate that ran
 * after writing could only report the breakage; running it first means a failed
 * generation leaves the suite exactly as it was.
 *
 * The check happens in a scratch copy — the existing suite files plus the
 * pending ones — so a page object and the spec importing it are typechecked
 * together, and a diverted file is checked in the position it will occupy.
 *
 * The scratch lives under `.flint/` rather than the system temp dir on purpose:
 * `moduleResolution` walks up from the tsconfig looking for `node_modules`, so
 * a copy outside the project would fail to find `@playwright/test` and report
 * a wall of missing-type errors that have nothing to do with the generated code.
 */

const SCRATCH_DIR = join('.flint', 'gate');

export interface GateResult {
  ok: boolean;
  errors: string[];
  /** False when the gate could not run; `ok` is then not evidence of anything. */
  ran: boolean;
  /** Why it did not run, when it did not. */
  skippedReason?: string;
}

export interface GateOptions {
  /** Absolute path of the project root (where `.flint/` lives). */
  projectRoot: string;
  /** Absolute path of the suite root. */
  suiteRoot: string;
  decisions: WriteDecision[];
  /** Existing suite files, as suite-relative path -> contents. */
  existingFiles: Map<string, string>;
  logger?: Logger;
  /** Escape hatch for projects with an unusual toolchain. */
  skip?: boolean;
}

export function runCompileGate(options: GateOptions): GateResult {
  const logger = options.logger ?? silentLogger();
  if (options.skip === true) {
    return { ok: true, errors: [], ran: false, skippedReason: 'disabled with --no-gate' };
  }

  const tsconfigPath = join(options.suiteRoot, 'tsconfig.json');
  if (!existsSync(tsconfigPath)) {
    return skip(logger, 'the suite has no tsconfig.json');
  }

  const tsconfig = readFileSync(tsconfigPath, 'utf8');
  if (/"extends"\s*:/.test(tsconfig)) {
    // A relative `extends` would resolve from the scratch directory and point
    // at nothing. Rather than typecheck against silently different options,
    // say so and let the human decide.
    return skip(logger, 'the suite tsconfig.json uses "extends", which the gate cannot relocate');
  }

  const scratch = resolve(options.projectRoot, SCRATCH_DIR);
  rmSync(scratch, { recursive: true, force: true });
  try {
    write(scratch, 'tsconfig.json', tsconfig);
    for (const [path, contents] of options.existingFiles) write(scratch, path, contents);
    for (const decision of options.decisions)
      write(scratch, decision.targetPath, decision.contents);

    const result = spawnSync(
      process.execPath,
      [typescriptBin(), '-p', 'tsconfig.json', '--noEmit'],
      {
        cwd: scratch,
        encoding: 'utf8',
        timeout: 120_000,
      },
    );

    // tsc writes diagnostics to stdout, not stderr.
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    if (result.status === 0) return { ok: true, errors: [], ran: true };

    const errors =
      output === '' ? ['tsc failed without producing diagnostics'] : output.split('\n');

    // A suite whose own dependencies are not installed cannot be typechecked,
    // and saying "the generated code is wrong" would send the user hunting a
    // bug that is not there. Only claim a failure we can actually attribute.
    if (isEnvironmentOnly(errors)) {
      return skip(
        logger,
        "the suite's own dependencies are not installed, so nothing could be typechecked (try `npm install` in the suite)",
      );
    }

    return { ok: false, errors, ran: true };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * True when every diagnostic is about a package the suite never installed,
 * rather than about the code Flint just wrote.
 *
 * `TS2688` is a missing `types` entry; `TS2307` is a missing module, but only
 * counts as environmental for a *bare* specifier — a relative one that cannot
 * be found means the emitter wrote a broken import, which is very much ours.
 */
function isEnvironmentOnly(errors: string[]): boolean {
  const diagnostics = errors.filter((line) => /error TS\d+:/.test(line));
  if (diagnostics.length === 0) return false;
  return diagnostics.every((line) => {
    if (/error TS2688:/.test(line)) return true;
    const missingModule = /error TS2307: Cannot find module '([^']+)'/.exec(line);
    return missingModule !== null && !missingModule[1]!.startsWith('.');
  });
}

function skip(logger: Logger, reason: string): GateResult {
  logger.warn({ reason }, 'generate: compile gate skipped');
  return { ok: true, errors: [], ran: false, skippedReason: reason };
}

/**
 * The TypeScript compiler Flint itself depends on — deliberately not the
 * user's. Generated code must be checked against a known-good compiler, and a
 * project whose own toolchain is broken should still be able to generate.
 */
function typescriptBin(): string {
  return createRequire(import.meta.url).resolve('typescript/bin/tsc');
}

function write(root: string, relative: string, contents: string): void {
  const absolute = resolve(root, relative);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents, 'utf8');
}
