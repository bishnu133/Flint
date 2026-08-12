import { createInterface } from 'node:readline/promises';
import { basename, join, resolve } from 'node:path';
import type { Command } from 'commander';
import { templatesDir } from '../../shared/paths.js';
import { applyScaffold, detectConflicts, planScaffold } from '../scaffold.js';

/**
 * `flint init` — scaffold the target-project layout (flint.config.ts, kb/,
 * e2e/ skeleton) from `templates/init/`.
 *
 * Re-running on an existing project PROMPTS and never clobbers: without a TTY or
 * `--force` it writes only the missing files and leaves existing ones untouched.
 */
export function registerInit(program: Command): void {
  program
    .command('init')
    .description('Scaffold a Flint project (config, knowledge base, e2e skeleton)')
    .option('-d, --dir <dir>', 'target project directory', '.')
    .option('-u, --base-url <url>', 'application base URL', 'https://www.saucedemo.com')
    .option('-n, --name <name>', 'project name (defaults to the directory name)')
    .option('-f, --force', 'overwrite existing files without prompting', false)
    .option('-y, --yes', 'assume yes to the overwrite prompt (non-interactive)', false)
    .action(async (opts: InitOptions) => {
      await runInit(opts);
    });
}

interface InitOptions {
  dir: string;
  baseUrl: string;
  name?: string;
  force: boolean;
  yes: boolean;
}

async function runInit(opts: InitOptions): Promise<void> {
  const targetDir = resolve(process.cwd(), opts.dir);
  const projectName = opts.name ?? basename(targetDir);
  const plan = planScaffold(join(templatesDir(), 'init'));
  const conflicts = detectConflicts(targetDir, plan);

  let overwrite = opts.force;
  if (conflicts.length > 0 && !opts.force) {
    console.log(`\n${conflicts.length} file(s) already exist in ${targetDir}:`);
    for (const c of conflicts) console.log(`  - ${c}`);

    if (opts.yes) {
      overwrite = true;
    } else if (process.stdin.isTTY) {
      overwrite = await confirm('\nOverwrite these files?');
    } else {
      overwrite = false;
      console.log(
        '\nNon-interactive session detected — leaving existing files untouched.\n' +
          'Re-run with --force to overwrite, or --yes to accept.',
      );
    }
  }

  const result = applyScaffold(
    targetDir,
    plan,
    { baseUrl: opts.baseUrl, projectName },
    { overwrite },
  );

  console.log(`\nFlint project scaffolded in ${targetDir}`);
  console.log(`  created: ${result.written.length} file(s)`);
  if (result.skipped.length > 0) {
    console.log(`  skipped (already present): ${result.skipped.length} file(s)`);
  }
  console.log('\nNext steps:');
  console.log('  1. Edit flint.config.ts (baseUrl, auth, models).');
  console.log('  2. Install the suite toolchain, which is separate from Flint:');
  console.log('       cd e2e && npm install && npx playwright install chromium');
  console.log('     Without it the generated suite cannot be typechecked or run.');
  console.log('  3. Write a feature spec under kb/features/.');
  console.log('  4. Run `flint hello-llm` to verify LLM wiring (needs ANTHROPIC_API_KEY).');
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}
