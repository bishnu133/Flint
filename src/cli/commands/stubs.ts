import type { Command } from 'commander';

/**
 * Registers the pipeline commands that are stubbed in Phase 0. Each is fully
 * described in `--help` but prints a clear "not yet implemented (Phase N)"
 * message when run, so the CLI surface is complete from day one.
 */

interface StubSpec {
  name: string;
  phase: number;
  description: string;
  args?: { name: string; description: string; required: boolean }[];
}

const STUBS: StubSpec[] = [
  {
    name: 'run',
    phase: 5,
    description: 'Run the generated Playwright suite',
  },
];

export function registerStubs(program: Command): void {
  for (const spec of STUBS) {
    const cmd = program.command(spec.name).description(spec.description);
    for (const arg of spec.args ?? []) {
      cmd.argument(arg.required ? `<${arg.name}>` : `[${arg.name}]`, arg.description);
    }
    cmd.action(() => {
      console.log(`\`flint ${spec.name}\` is not yet implemented (Phase ${spec.phase}).`);
      process.exitCode = 2;
    });
  }
}
