import { Command } from 'commander'
import { addRunOptions } from './run-options'
import { runAction } from './request'

/**
 * Top-level `fp run` — ergonomic alias for `fp request run`. Same options, same
 * action, so the two produce identical output.
 */
export function registerRunAlias(program: Command): void {
  addRunOptions(program.command('run').description('alias for `fp request run`')).action(runAction)
}
