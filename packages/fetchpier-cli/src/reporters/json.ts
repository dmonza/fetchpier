import { promises as fs } from 'node:fs'
import type { ExecutionWarning } from '@shared/types'
import type { RequestUnit, RunSummary } from '../types'
import type { Reporter, RunMeta, UnitStart } from './types'

export interface JsonReporterOptions {
  /** Output path, or `'-'` for stdout. */
  output: string
  /** Omit response bodies for lighter reports. */
  noBody?: boolean
  /** stdout sink for `output: '-'` — injectable for tests. */
  write?: (s: string) => void
}

/**
 * JSON reporter. Emits the {@link RunSummary} verbatim (schema version `1.0`).
 * Authorization headers are already redacted upstream (in `toRequestUnit`);
 * `noBody` additionally strips response bodies. Writes to a file, or to stdout
 * when `output` is `'-'` (in which case the CLI reporter is silenced so the
 * JSON stays parseable).
 */
export class JsonReporter implements Reporter {
  private summary?: RunSummary
  /**
   * REQ-0115: warnings used to be dropped here entirely — every kind, not just
   * the cookie ones — so a pipeline consuming the report could not see that the
   * run had produced any. They are collected and emitted alongside the summary,
   * carrying the engine's `code` where there is one so a consumer matches on
   * that rather than on the message text.
   */
  private readonly warnings: { message: string; detail?: ExecutionWarning }[] = []
  constructor(private readonly opts: JsonReporterOptions) {}

  runStart(_meta: RunMeta): void {}
  unitStart(_unit: UnitStart): void {}
  unitComplete(_unit: RequestUnit): void {}
  runComplete(summary: RunSummary): void {
    this.summary = summary
  }
  error(): void {}
  warn(message: string, detail?: ExecutionWarning): void {
    this.warnings.push(detail ? { message, detail } : { message })
  }
  log(): void {}

  async finalize(): Promise<void> {
    if (!this.summary) return
    const base = this.opts.noBody ? stripBodies(this.summary) : this.summary
    // Additive: a consumer written against the previous shape is unaffected.
    const payload = this.warnings.length > 0 ? { ...base, warnings: this.warnings } : base
    const json = JSON.stringify(payload, null, 2)
    if (this.opts.output === '-') {
      ;(this.opts.write ?? ((s) => process.stdout.write(s)))(`${json}\n`)
    } else {
      await fs.writeFile(this.opts.output, json, 'utf-8')
    }
  }
}

/** Deep-ish clone that drops `response.body` from every unit. */
function stripBodies(summary: RunSummary): RunSummary {
  return {
    ...summary,
    units: summary.units.map((u): RequestUnit => {
      if (!u.response) return u
      const { body: _body, ...rest } = u.response
      return { ...u, response: { ...rest, body: '' } }
    })
  }
}
