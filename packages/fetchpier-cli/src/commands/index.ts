import { Command } from 'commander'
import { registerRequestCommand } from './request'
import { registerRunAlias } from './run'
import { registerEnvCommand } from './env'
import { registerInitCommand } from './init'

/** Register every command on the program. */
export function registerCommands(program: Command): void {
  registerRunAlias(program) // `fp run` — top-level alias
  registerRequestCommand(program) // `fp request run`
  registerEnvCommand(program) // `fp env list|current`
  registerInitCommand(program) // `fp init [name]`
}
