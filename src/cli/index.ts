#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { packageRoot } from '../shared/paths.js';
import { isTestGenError } from '../shared/errors.js';
import { registerInit } from './commands/init.js';
import { registerHelloLlm } from './commands/hello-llm.js';
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
    .name('testgen')
    .description('AI-powered Playwright test suite generator')
    .version(version(), '-V, --version');

  // Implemented in Phase 0.
  registerInit(program);
  registerHelloLlm(program);

  // Pipeline commands (stubbed until their phase).
  registerStubs(program);

  return program;
}

async function main(): Promise<void> {
  const program = buildProgram();
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (isTestGenError(err)) {
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
