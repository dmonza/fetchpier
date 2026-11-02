import { Command } from 'commander'
import { EXIT } from '../../exit-codes'
import { getRunSignal } from '../../runtime-signal'
import { addRunOptions, toRunOptions } from '../run-options'
import { executeRun } from './run'

/**
 * Run action shared by `fp request run` and the `fp run` alias. Builds the run
 * options, wires the cancellation signal, executes, and sets the process exit
 * code from the outcome (test/script failures → 1, unless suppressed). Fatal
 * errors propagate to the binary's top-level handler.
 */
export async function runAction(
  paths: string[],
  raw: Parameters<typeof toRunOptions>[1]
): Promise<void> {
  const options = toRunOptions(paths, raw)
  options.signal = getRunSignal()

  const summary = await executeRun(options)

  if (options.signal?.aborted) {
    process.exitCode = EXIT.SIGINT
    return
  }
  // REQ-0111: failed *requests* count too. A file that declares no assertions
  // and whose service was unreachable used to exit 0 — the run reported the
  // failure in its summary and nothing consulted it. One general failure code
  // covers every request-level cause (transport, assertion, script), so a run
  // mixing them needs no precedence rule; the per-unit reason in the report
  // carries the cause, which an exit code could not.
  if (
    !options.suppressExitCode &&
    (summary.summary.requests.failed > 0 ||
      summary.summary.tests.failed > 0 ||
      summary.summary.scriptErrors > 0)
  ) {
    process.exitCode = EXIT.TEST_FAILURE
  }
}

/** Register the `request` domain (`fp request run …`). */
export function registerRequestCommand(program: Command): void {
  const request = program
    .command('request')
    .description('run and inspect requests in the workspace')

  addRunOptions(request.command('run').description('run one or more requests')).action(runAction)
}
