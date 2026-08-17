#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { packageRoot } from '../shared/paths.js';
import { isFlintError } from '../shared/errors.js';
import { registerInit } from './commands/init.js';
import { registerHelloLlm } from './commands/hello-llm.js';
import { registerExplore } from './commands/explore.js';
import { registerIndex } from './commands/index-cmd.js';
import { registerManifest } from './commands/manifest.js';
import { registerPlan } from './commands/plan.js';
import { registerGenerate } from './commands/generate.js';
import { registerVerify } from './commands/verify.js';
import { registerCi } from './commands/ci.js';
import { registerBench } from './commands/bench.js';
import { registerPr } from './commands/pr.js';
import { registerStubs } from './commands/stubs.js';

function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('flint')
    .description('AI-powered Playwright test suite generator')
    .version(version(), '-V, --version');

  // Implemented in Phase 0.
  registerInit(program);
  registerHelloLlm(program);

  // Implemented in Phase 1.
  registerExplore(program);
  registerIndex(program);
  registerManifest(program);
  registerPlan(program);

  // Implemented in Phase 4.
  registerGenerate(program);

  // Implemented in Phase 5.
  registerVerify(program);
  registerCi(program);
  registerBench(program);
  registerPr(program);

  // Pipeline commands (stubbed until their phase).
  registerStubs(program);

  return program;
}

async function main(): Promise<void> {
  const program = buildProgram();
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (isFlintError(err)) {
      console.error(`\nerror: ${err.message}`);
      if (err.hint) console.error(`hint: ${err.hint}`);
      process.exitCode = 1;
      return;
    }
    // Unexpected error: show the message but not a raw stack trace to CLI users.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\nunexpected error: ${message}`);
    process.exitCode = 1;
  }
}

void main();
