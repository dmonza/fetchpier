import { homedir } from 'node:os'
import type { ChalkInstance } from 'chalk'
import type { RequestUnit, RunSummary } from '../types'
import { formatDuration, formatSize } from '../output/formatters'
import type { GlyphSet } from '../output/glyphs'
import type { Reporter, RunMeta, UnitStart } from './types'

export interface CliReporterOptions {
  glyphs: GlyphSet
  colors: ChalkInstance
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

export class CliReporter implements Reporter {
  private readonly g: GlyphSet
  private readonly c: ChalkInstance
  private readonly silent: boolean
  private readonly out: (line: string) => void
  private readonly err: (line: string) => void

  private mode: 'single' | 'multi' = 'single'
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
    this.line(`Workspace: ${abbreviateHome(meta.workspace)}`)
    this.line(`Environment: ${meta.environment}`)
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
    this.printScriptSection('pre-request script', unit.scripts.preRequest)

    if (unit.response) {
      this.line(`  ${this.g.arrowOut} ${unit.request.method} ${unit.request.url}`)
      this.line(`  ${this.g.arrowIn} ${this.responseLine(unit.response)}`)
    } else {
      this.line(`  ${this.g.arrowOut} ${unit.request.method} ${unit.request.url}`)
      this.line(`  request not sent${unit.error ? `: ${unit.error}` : ''}`)
    }

    this.printScriptSection('post-response script', unit.scripts.postResponse)
    this.printTests(unit)
  }

  private printScriptSection(
    label: string,
    section?: {
      logs: { level: string; message: string }[]
      errors: { message: string; line?: number }[]
    }
  ): void {
    if (!section) return
    const { logs, errors } = section
    if (errors.length > 0) {
      this.line(`  ${label}:`)
      for (const e of errors) {
        this.line(`    ${this.c.red(this.g.fail)} ${e.message}`)
        if (e.line != null) this.line(`        at line ${e.line}`)
      }
      return
    }
    if (logs.length === 0) {
      this.line(`  ${label}: ran (no output)`)
      return
    }
    this.line(`  ${label}:`)
    for (const l of logs) {
      this.line(`    [${l.level}] ${l.message}`)
    }
  }

  private printTests(unit: RequestUnit): void {
    if (unit.tests.length === 0) return
    this.line(`  Tests:`)
    let passed = 0
    let failed = 0
    for (const t of unit.tests) {
      if (t.passed) {
        passed++
        this.line(`    ${this.c.green(this.g.pass)} ${t.name}`)
      } else {
        failed++
        this.line(`    ${this.c.red(this.g.fail)} ${t.name}`)
        if (t.error) this.line(`        ${t.error}`)
      }
    }
    this.line(`    ${this.testCountSummary(passed, failed)}`)
  }

  private testCountSummary(passed: number, failed: number): string {
    if (failed === 0) return `${passed} passed`
    return `${passed} passed, ${failed} failed`
  }

  // ── Compact (multi) ─────────────────────────────────────────────────────────

  private printCompact(unit: RequestUnit): void {
    const label = `${this.g.bullet} ${unit.request.method} ${urlPath(unit.request.url)}`.padEnd(
      COMPACT_LABEL_WIDTH
    )

    if (!unit.response) {
      const errCount = this.scriptErrorCount(unit)
      const reason = unit.error ? `: ${unit.error}` : ''
      this.line(
        `${label} ${this.c.red(`request not sent${reason}`)}${errCount ? ` (${errCount} script error)` : ''}`
      )
      return
    }

    const total = unit.tests.length
    const passed = unit.tests.filter((t) => t.passed).length
    const ok = passed === total && !this.hasScriptError(unit)
    const testGlyph = ok ? this.c.green(this.g.pass) : this.c.red(this.g.fail)
    const tests = total > 0 ? ` ${this.g.sep} ${testGlyph} ${passed}/${total} tests` : ''
    this.line(`${label} ${this.g.arrowIn} ${this.responseLine(unit.response)}${tests}`)
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
    // Count what the footer could not otherwise say: a request that never got a
    // response. A request that failed on an assertion is already described by the
    // tests part, so a generic "N failed" here would read ambiguously beside it.
    const notSent = summary.units.filter((u) => !u.response).length
    if (notSent > 0) parts.push(`${notSent} not sent`)
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

  private responseLine(r: NonNullable<RequestUnit['response']>): string {
    const status = `${r.status} ${r.statusText}`.trim()
    const colored = r.status >= 400 ? this.c.red(status) : this.c.green(status)
    return `${colored} ${this.g.sep} ${formatDuration(r.timingMs)} ${this.g.sep} ${formatSize(r.sizeBytes)}`
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
