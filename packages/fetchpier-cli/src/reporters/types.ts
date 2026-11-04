import type { ExecutionWarning } from '@shared/types'
import type { RequestUnit, RunSummary, Verbosity } from '../types'

// ── Reporter contract ────────────────────────────────────────────────────────
//
// `commands/request/run.ts` is the SOLE producer of these events; the built-in
// reporters (cli, json, junit, html) are consumers. The event order for a run
// is always:
//
//   runStart → (unitStart → unitComplete)* → runComplete → finalize
//
// `warn`/`log`/`error` may be interleaved at any point. `error` reports a fatal
// condition (the run is aborting); it goes to stderr. A request/test/script
// *failure* is NOT an `error` — it is carried in the `RequestUnit` passed to
// `unitComplete`. Per-unit script logs/errors live inside `RequestUnit.scripts`
// (the producer folds them in), so there is no separate `scriptResult` event.

export interface RunMeta {
  workspace: string
  /** Opaque environment identifier. */
  environment: string
  /** The environment's folder name — the readable handle (`--env`). */
  environmentName: string
  /** The proxy in effect for the run, described without credentials. */
  proxy?: { display: string; source: string }
  cliVersion: string
  /** ISO timestamp. */
  startedAt: string
  /** Number of requests about to run — lets the CLI reporter choose its layout. */
  plannedUnits: number
  verbosity: Verbosity
  showSecrets: boolean
}

export interface UnitStart {
  /** Path relative to the workspace. */
  path: string
  name: string
  method: string
  /** The pre-resolution URL (may contain `{{placeholders}}`). */
  urlTemplate: string
}

export interface Reporter {
  runStart(meta: RunMeta): void
  unitStart(unit: UnitStart): void
  unitComplete(unit: RequestUnit): void
  runComplete(summary: RunSummary): void
  /** Fatal condition aborting the run. Goes to stderr. */
  error(message: string, hints?: string[]): void
  /**
   * Non-fatal warning. Goes to stderr.
   *
   * `detail` carries the engine's structured advisory when the warning came from
   * one (REQ-0115). Reporters aimed at a human ignore it; machine-readable ones
   * emit it so a pipeline can match on `code` instead of on the prose, which is
   * free to change. Absent for warnings the adapter raises on its own.
   */
  warn(message: string, detail?: ExecutionWarning): void
  /** Diagnostic line (verbose modes). */
  log(message: string): void
  /** Flush buffered output / write files. Called once at the end and on abort. */
  finalize(): void | Promise<void>
}
