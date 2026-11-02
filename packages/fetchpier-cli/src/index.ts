/*! Fetchpier — Copyright (c) 2026 Daniel Monza — MIT — https://fetchpier.com */

// Programmatic API for `@fetchpier/cli`. The same engine the `fp` binary drives,
// exposed for use from your own Node scripts:
//
//   import { run } from '@fetchpier/cli'
//   const summary = await run({ paths: ['auth/login.http'], workspace: '/path' })
//
// `run` returns the structured RunSummary and never calls `process.exit` — the
// caller decides what to do with the result.

import { executeRun } from './commands/request/run'
import { initWorkspace, type InitOptions } from './commands/init'
import { currentEnvironment } from './commands/env/current'
import { listEnvironments } from './context/list-environments'
import type { RunOptions, RunSummary } from './types'

/** Run one or more requests and return the structured summary. */
export function run(options: RunOptions): Promise<RunSummary> {
  return executeRun(options)
}

/** Create a new workspace; returns its absolute path. */
export function init(options?: InitOptions): Promise<string> {
  return initWorkspace(options)
}

export { listEnvironments, currentEnvironment }
export type { InitOptions, Template } from './commands/init'

export { CLI_VERSION } from './version'
export { EXIT, type ExitCode } from './exit-codes'
export { CliError } from './errors'
export type {
  RunOptions,
  RunSummary,
  RunUnit,
  RequestUnit,
  ReporterConfig,
  ScriptLog,
  ScriptError,
  ScriptMutationSummary,
  Verbosity
} from './types'
