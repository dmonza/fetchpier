#!/usr/bin/env node
// MUST stay the first import: this module's body refuses an unsupported Node
// and exits. Everything below it — commander, core, and core's module-scope
// `require("undici")` — loads on the host runtime before `main()` is reached,
// so a check placed anywhere later would never get to print. `node-floor.test.ts`
// asserts this import stays first.
import './node-floor'
import { Command } from 'commander'
import { formatBanner } from './banner'
import { registerCommands } from './commands'
import { EXIT } from './exit-codes'
import { resolveError } from './errors'
import { setRunSignal } from './runtime-signal'

/**
 * Binary entry point. Parses argv with commander, wires SIGINT/SIGTERM to an
 * AbortController so an in-flight request is cancelled cleanly, and funnels
 * every thrown value through `resolveError` to a deterministic exit code.
 */
async function main(): Promise<void> {
  // Cancellation: Ctrl-C / SIGTERM abort in-flight requests; the run finishes
  // its teardown (partial reporters flush) and exits 130.
  const controller = new AbortController()
  setRunSignal(controller.signal)
  const onSignal = (): void => {
    controller.abort()
    process.exitCode = EXIT.SIGINT
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  const program = new Command()
  program
    .name('fp')
    .description('Fetchpier CLI — run requests and inspect environments from the terminal')
    .version(formatBanner(), '-V, --version', 'output the version and copyright notice')
    .showSuggestionAfterError(true)

  registerCommands(program)

  // A bare `fp` is a usage error: commander prints its help to stderr and exits
  // 1. Announce the product above it, on stderr too, so stdout stays empty for
  // callers that parse it. No other invocation prints a banner.
  if (process.argv.length <= 2) {
    process.stderr.write(`${formatBanner()}\n\n`)
  }

  await program.parseAsync(process.argv)
}

main().catch((err) => {
  const resolved = resolveError(err)
  process.stderr.write(`Error: ${resolved.message}\n`)
  for (const hint of resolved.hints) {
    process.stderr.write(`${hint ? `  ${hint}` : ''}\n`)
  }
  if (resolved.stack) process.stderr.write(`\n${resolved.stack}\n`)
  process.exit(resolved.exitCode)
})
