import { homedir } from 'node:os'
import type { Colors } from '../output/colors'
import { activityLog } from '@fetchpier/core'
import type { RequestUnit, RunSummary, Verbosity } from '../types'
import { formatDuration, formatSize, truncateBody } from '../output/formatters'
import type { GlyphSet } from '../output/glyphs'
import type { Reporter, RunMeta, UnitStart } from './types'
import { notRun } from './unit-outcome'

export interface CliReporterOptions {
  glyphs: GlyphSet
  colors: Colors
  /** When true, suppress all stdout (errors still go to stderr). */
  silent?: boolean
  /** stdout sink — injectable for tests. */
  write?: (line: string) => void
  /** stderr sink — injectable for tests. */
  writeErr?: (line: string) => void
}

/** Replace a leading home-directory path with `~` for compact display. */
function abbreviateHome(p: string): string {
  const home = homedir()
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p
}

/** Pathname of a resolved URL, falling back to the raw string when unparseable. */
function urlPath(url: string): string {
  try {
    const u = new URL(url)
    return u.pathname + u.search
  } catch {
    return url
  }
}

const COMPACT_LABEL_WIDTH = 30

/**
 * Human output. Verbosity levels are cumulative and identical for single- and
 * multi-request runs:
 *  - default: the request line, the response line, script output and (single)
 *    the test list; multi-request runs show script output under each line;
 *  - `-v`: the per-request test list in multi-request runs, and full URLs;
 *  - `-vv`: request and response headers;
 *  - `-vvv`: request and response bodies, each cut at 64 KB.
 * Everything printed has already been masked and redacted upstream.
 */
export class CliReporter implements Reporter {
  private readonly g: GlyphSet
  private readonly c: Colors
  private readonly silent: boolean
  private readonly out: (line: string) => void
  private readonly err: (line: string) => void

  private mode: 'single' | 'multi' = 'single'
  private verbosity: Verbosity = 0
  private readonly failures: RequestUnit[] = []

  constructor(opts: CliReporterOptions) {
    this.g = opts.glyphs
    this.c = opts.colors
    this.silent = opts.silent ?? false
    this.out = opts.write ?? ((l) => process.stdout.write(l))
    this.err = opts.writeErr ?? ((l) => process.stderr.write(l))
  }

  private line(s = ''): void {
    if (!this.silent) this.out(`${s}\n`)
  }

  runStart(meta: RunMeta): void {
    this.mode = meta.plannedUnits === 1 ? 'single' : 'multi'
    this.verbosity = meta.verbosity
    this.line(`Workspace: ${abbreviateHome(meta.workspace)}`)
    // The folder name is what `--env` accepts; the opaque id says nothing.
    this.line(`Environment: ${meta.environmentName}`)
    if (meta.proxy) {
      // The exclusion list is part of the configuration: without it the line
      // reads as if every request used the proxy. Per-request truth is `-v`.
      const exclusions = meta.proxy.noProxy ? `; NO_PROXY: ${meta.proxy.noProxy}` : ''
      this.line(`Proxy: ${meta.proxy.display} (from ${meta.proxy.source}${exclusions})`)
    }
    this.line()
  }

  unitStart(unit: UnitStart): void {
    if (this.mode === 'single') {
      this.line(`${this.g.bullet} ${unit.method} ${unit.urlTemplate}`)
    }
    // Multi mode prints a single line on completion instead.
  }

  unitComplete(unit: RequestUnit): void {
    const hasFailure = unit.tests.some((t) => !t.passed) || this.hasScriptError(unit)
    if (hasFailure) this.failures.push(unit)

    if (this.mode === 'multi') {
      this.printCompact(unit)
      return
    }
    this.printSingleBlock(unit)
  }

  // ── Single-request block ──────────────────────────────────────────────────

  private printSingleBlock(unit: RequestUnit): void {
    this.printScriptSection('pre-request script', unit.scripts.preRequest, '  ')

    this.line(
      `  ${this.g.arrowOut} ${unit.request.method} ${unit.request.url}${this.viaText(unit)}`
    )
    this.printRequestDetails(unit, '    ')
    if (unit.response) {
      this.line(`  ${this.g.arrowIn} ${this.responseLine(unit.response)}`)
      this.printResponseDetails(unit, '    ')
    } else {
      this.line(`  ${this.noResponseText(unit)}`)
    }

    this.printScriptSection('post-response script', unit.scripts.postResponse, '  ')
    this.printTests(unit, '  ')
  }

  private printScriptSection(
    label: string,
    section:
      | {
          logs: { level: string; message: string }[]
          errors: { message: string; line?: number }[]
        }
      | undefined,
    indent: string
  ): void {
    if (!section) return
    const { logs, errors } = section
    if (errors.length > 0) {
      this.line(`${indent}${label}:`)
      for (const l of logs) this.line(`${indent}  [${l.level}] ${l.message}`)
      for (const e of errors) {
        this.line(`${indent}  ${this.c.red(this.g.fail)} ${e.message}`)
        if (e.line != null) this.line(`${indent}      at line ${e.line}`)
      }
      return
    }
    if (logs.length === 0) {
      if (this.mode === 'single') this.line(`${indent}${label}: ran (no output)`)
      return
    }
    this.line(`${indent}${label}:`)
    for (const l of logs) this.line(`${indent}  [${l.level}] ${l.message}`)
  }

  private printTests(unit: RequestUnit, indent: string): void {
    if (unit.tests.length === 0) return
    this.line(`${indent}Tests:`)
    let passed = 0
    let failed = 0
    for (const t of unit.tests) {
      if (t.passed) {
        passed++
        this.line(`${indent}  ${this.c.green(this.g.pass)} ${t.name}`)
      } else {
        failed++
        this.line(`${indent}  ${this.c.red(this.g.fail)} ${t.name}`)
        if (t.error) this.line(`${indent}      ${t.error}`)
      }
    }
    if (this.mode === 'single') this.line(`${indent}  ${this.testCountSummary(passed, failed)}`)
  }

  private testCountSummary(passed: number, failed: number): string {
    if (failed === 0) return `${passed} passed`
    return `${passed} passed, ${failed} failed`
  }

  // ── Verbose details (-vv headers, -vvv bodies) ──────────────────────────────

  private printRequestDetails(unit: RequestUnit, indent: string): void {
    if (this.verbosity >= 2) this.printHeaders(unit.request.headers, indent)
    if (this.verbosity >= 3 && unit.request.body !== undefined && unit.request.body !== '') {
      this.printBody(unit.request.body, unit.request.headers, false, indent)
    }
  }

  private printResponseDetails(unit: RequestUnit, indent: string): void {
    if (!unit.response) return
    if (this.verbosity >= 2) this.printHeaders(unit.response.headers, indent)
    if (this.verbosity >= 3 && unit.response.body !== '') {
      this.printBody(
        unit.response.body,
        unit.response.headers,
        unit.response.decodingStatus === 'decoded',
        indent
      )
    }
  }

  private printHeaders(headers: Record<string, string>, indent: string): void {
    for (const [k, v] of Object.entries(headers)) this.line(`${indent}${k}: ${v}`)
  }

  private printBody(
    body: string,
    headers: Record<string, string>,
    decoded: boolean,
    indent: string
  ): void {
    // Binary is never dumped to the terminal (the activity log's rule, with a
    // decoded body judged by its content): one line saying what it is instead.
    if (activityLog.detectBinaryBody({ headers, body, decoded }).isBinary) {
      const type =
        Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ??
        'application/octet-stream'
      this.line(
        `${indent}<binary body: ${formatSize(Buffer.byteLength(body, 'utf-8'))}, ${type} — use --reporter-json for the full body>`
      )
      return
    }
    const { text, truncated, totalBytes } = truncateBody(body)
    this.line(`${indent}`)
    for (const l of text.split('\n')) this.line(`${indent}${l}`)
    if (truncated) {
      this.line(
        `${indent}… (truncated: ${formatSize(totalBytes)} total; use --reporter-json for the full body)`
      )
    }
  }

  // ── Compact (multi) ─────────────────────────────────────────────────────────

  private printCompact(unit: RequestUnit): void {
    const target = this.verbosity >= 1 ? unit.request.url : urlPath(unit.request.url)
    const label = `${this.g.bullet} ${unit.request.method} ${target}${this.viaText(unit)}`.padEnd(
      COMPACT_LABEL_WIDTH
    )

    if (!unit.response) {
      const errCount = this.scriptErrorCount(unit)
      this.line(
        `${label} ${this.c.red(this.noResponseText(unit))}${errCount ? ` (${errCount} script error)` : ''}`
      )
    } else {
      const total = unit.tests.length
      const passed = unit.tests.filter((t) => t.passed).length
      const ok = passed === total && !this.hasScriptError(unit)
      const testGlyph = ok ? this.c.green(this.g.pass) : this.c.red(this.g.fail)
      const tests = total > 0 ? ` ${this.g.sep} ${testGlyph} ${passed}/${total} tests` : ''
      this.line(`${label} ${this.g.arrowIn} ${this.responseLine(unit.response)}${tests}`)
    }

    // Script output belongs to the request that produced it, at every level —
    // it used to be invisible whenever a run had more than one file.
    this.printScriptSection('pre-request script', unit.scripts.preRequest, '    ')
    if (this.verbosity >= 2) {
      this.line(`    ${this.g.arrowOut} request`)
      this.printRequestDetails(unit, '      ')
      if (unit.response) {
        this.line(`    ${this.g.arrowIn} response`)
        this.printResponseDetails(unit, '      ')
      }
    }
    this.printScriptSection('post-response script', unit.scripts.postResponse, '    ')
    if (this.verbosity >= 1) this.printTests(unit, '    ')
  }

  // ── Footer + Failures ─────────────────────────────────────────────────────

  runComplete(summary: RunSummary): void {
    if (this.mode === 'multi' && this.failures.length > 0) {
      this.line()
      this.line(`Failures:`)
      for (const unit of this.failures) {
        this.line(`  ${unit.request.method} ${urlPath(unit.request.url)}`)
        for (const t of unit.tests.filter((x) => !x.passed)) {
          this.line(`    ${this.c.red(this.g.fail)} ${t.name}`)
          if (t.error) this.line(`        ${t.error}`)
          this.line(`        at ${unit.path}`)
        }
        for (const e of this.scriptErrors(unit)) {
          this.line(`    ${this.c.red(this.g.fail)} ${e.message}`)
          this.line(`        at ${unit.path}`)
        }
      }
    }

    this.line()
    this.line(this.footer(summary))
  }

  private footer(summary: RunSummary): string {
    const { requests, tests, scriptErrors } = summary.summary
    // REQ-0111: failed requests count. Omitting them printed a green tick and
    // "1 request, 0 tests" for a run whose service was unreachable — the same
    // false green the exit code and the CI report had.
    const allOk = requests.failed === 0 && tests.failed === 0 && scriptErrors === 0
    const glyph = allOk ? this.c.green(this.g.pass) : this.c.red(this.g.fail)
    const reqWord = requests.total === 1 ? 'request' : 'requests'
    const dur = `(${formatDuration(summary.durationMs)})`

    const parts: string[] = [`${requests.total} ${reqWord}`]
    // Count what the footer could not otherwise say: a request that got no
    // response, split by whether a send was even attempted.
    const responseless = summary.units.filter((u) => !u.response)
    const notRunCount = responseless.filter(notRun).length
    const noResponseCount = responseless.length - notRunCount
    if (noResponseCount > 0) parts.push(`${noResponseCount} no response`)
    if (notRunCount > 0) parts.push(`${notRunCount} not run`)
    if (tests.failed > 0) {
      // Single-request runs read more naturally as "1 of 2 tests failed";
      // multi-request runs lead with the passing count, matching the spec.
      if (this.mode === 'single') {
        parts.push(`${tests.failed} of ${tests.total} tests failed`)
      } else {
        parts.push(`${tests.passed} of ${tests.total} tests passed`, `${tests.failed} failed`)
      }
    } else if (tests.total > 0) {
      parts.push(`${tests.total} ${tests.total === 1 ? 'test' : 'tests'} passed`)
    } else {
      parts.push(`0 tests`)
    }
    if (scriptErrors > 0) {
      parts.push(`${scriptErrors} script ${scriptErrors === 1 ? 'error' : 'errors'}`)
    }
    return `${glyph} ${parts.join(', ')} ${dur}`
  }

  // ── Diagnostics ─────────────────────────────────────────────────────────────

  error(message: string, hints: string[] = []): void {
    this.err(`${this.c.red('Error:')} ${message}\n`)
    for (const h of hints) this.err(`${h ? `  ${h}` : ''}\n`)
  }

  warn(message: string): void {
    this.err(`${this.c.yellow('Warning:')} ${message}\n`)
  }

  log(message: string): void {
    this.line(message)
  }

  finalize(): void {
    // CLI reporter writes incrementally; nothing to flush.
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * `no response: <reason>` when a send was attempted (unreachable, TLS,
   * timeout, proxy, interrupt); `not run: <reason>` when none was (a file with
   * no request, a pre-request script that aborted).
   */
  /** ` (via proxy)` / ` (direct)` at `-v` and above, when the run has a proxy. */
  private viaText(unit: RequestUnit): string {
    if (this.verbosity < 1 || !unit.via) return ''
    return unit.via === 'proxy' ? ' (via proxy)' : ' (direct)'
  }

  private noResponseText(unit: RequestUnit): string {
    const label = notRun(unit) ? 'not run' : 'no response'
    return `${label}${unit.error ? `: ${unit.error}` : ''}`
  }

  private responseLine(r: NonNullable<RequestUnit['response']>): string {
    const status = `${r.status} ${r.statusText}`.trim()
    const colored = r.status >= 400 ? this.c.red(status) : this.c.green(status)
    return `${colored} ${this.g.sep} ${formatDuration(r.timingMs)} ${this.g.sep} ${this.sizeText(r)}`
  }

  /** `1.2KB`, or `1.2KB (8.4KB decoded)` for a compressed response; notes a decoding problem. */
  private sizeText(r: NonNullable<RequestUnit['response']>): string {
    const base =
      r.decodingStatus === 'decoded' &&
      r.compressedBytes !== undefined &&
      r.decompressedBytes !== undefined
        ? `${formatSize(r.compressedBytes)} (${formatSize(r.decompressedBytes)} decoded)`
        : formatSize(r.sizeBytes)
    if (r.decodingStatus === 'failed') return `${base} (could not be decoded)`
    if (r.decodingStatus === 'unsupported') return `${base} (unsupported encoding)`
    return base
  }

  private hasScriptError(unit: RequestUnit): boolean {
    return this.scriptErrorCount(unit) > 0
  }

  private scriptErrorCount(unit: RequestUnit): number {
    return this.scriptErrors(unit).length
  }

  private scriptErrors(unit: RequestUnit): { message: string; line?: number }[] {
    return [
      ...(unit.scripts.preRequest?.errors ?? []),
      ...(unit.scripts.postResponse?.errors ?? [])
    ]
  }
}
