import { Command } from 'commander'
import { currentCommand } from './current'
import { listCommand } from './list'

/**
 * Register the `env` domain. MVP: `list` and `current`. There is deliberately no
 * `switch` — the desktop persists the active environment in its own user-data
 * store (outside the workspace), which the CLI cannot write to. `fp env current`
 * reflects the CLI's CI-friendly resolution (`--env`/`FETCHPIER_ENV`/`default`),
 * NOT the desktop's last UI selection.
 */
export function registerEnvCommand(program: Command): void {
  const env = program.command('env').description('inspect workspace environments')

  env
    .command('list')
    .description('list all environments in the workspace')
    .option('-w, --workspace <path>', 'workspace folder (default: discovered from cwd)')
    .action((opts) => listCommand(opts))

  env
    .command('current')
    .description(
      "print the environment a run would use (--env > FETCHPIER_ENV > 'default'; ignores desktop UI selection)"
    )
    .option('-w, --workspace <path>', 'workspace folder (default: discovered from cwd)')
    .option('-e, --env <name>', 'environment id to report as current')
    .action((opts) => currentCommand(opts))
}
