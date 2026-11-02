import { promises as fs } from 'node:fs'
import { escapeAttr, escapeXml } from '../output/escape'
import type { RequestUnit, RunSummary } from '../types'
import type { Reporter, RunMeta, UnitStart } from './types'

export interface JunitReporterOptions {
  output: string
}

function classnameOf(unit: RequestUnit): string {
  let path = unit.request.url
  try {
    const u = new URL(unit.request.url)
    path = u.pathname + u.search
  } catch {
    /* keep raw */
  }
  return `${unit.request.method} ${path}`
}

function sec(ms: number): string {
  return (ms / 1000).toFixed(3)
}

function scriptErrorsOf(unit: RequestUnit): { message: string; stack?: string }[] {
  return [...(unit.scripts.preRequest?.errors ?? []), ...(unit.scripts.postResponse?.errors ?? [])]
}

/**
 * The counters one unit contributes. Single source for the suite element and
 * the root aggregate, so the two cannot disagree.
 *
 * A request that never got a response has no assertions, so a suite counted
 * purely from them would render as empty-and-passing — a dashboard would show
 * green for a service that was unreachable. It contributes one synthetic error
 * case instead (REQ-0111).
 */
function suiteCounts(unit: RequestUnit): { tests: number; failures: number; errors: number } {
  const failures = unit.tests.filter((t) => !t.passed).length
  const errors = scriptErrorsOf(unit).length + (unit.response ? 0 : 1)
  return { tests: unit.tests.length + errors, failures, errors }
}

/**
 * JUnit XML reporter — the lingua franca consumed by Jenkins, GitLab, and Azure
 * DevOps. One `<testsuite>` per request file, one `<testcase>` per test. Failed
 * assertions become `<failure>`; uncaught script errors become `<error>`.
 */
export class JunitReporter implements Reporter {
  private summary?: RunSummary
  constructor(private readonly opts: JunitReporterOptions) {}

  runStart(_meta: RunMeta): void {}
  unitStart(_unit: UnitStart): void {}
  unitComplete(_unit: RequestUnit): void {}
  runComplete(summary: RunSummary): void {
    this.summary = summary
  }
  error(): void {}
  warn(): void {}
  log(): void {}

  async finalize(): Promise<void> {
    if (!this.summary) return
    await fs.writeFile(this.opts.output, this.render(this.summary), 'utf-8')
  }

  private render(summary: RunSummary): string {
    const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>']
    // Aggregate from what the suites actually emit, rather than from the run
    // summary. The summary counts `scriptErrors` as units-that-had-one, while a
    // suite emits one case per error *entry* — so the root used to disagree with
    // the sum of its children whenever a unit had more than one script error.
    // Deriving both from the same source removes that drift and lets the
    // synthetic transport case be counted the same way as everything else.
    const totals = summary.units.reduce(
      (acc, u) => {
        const counts = suiteCounts(u)
        acc.tests += counts.tests
        acc.failures += counts.failures
        acc.errors += counts.errors
        return acc
      },
      { tests: 0, failures: 0, errors: 0 }
    )
    lines.push(
      `<testsuites name="Fetchpier" tests="${totals.tests}" failures="${totals.failures}" errors="${totals.errors}" time="${sec(summary.durationMs)}">`
    )
    for (const unit of summary.units) {
      lines.push(...this.renderSuite(unit))
    }
    lines.push('</testsuites>')
    return `${lines.join('\n')}\n`
  }

  private renderSuite(unit: RequestUnit): string[] {
    const classname = classnameOf(unit)
    const scriptErrs = scriptErrorsOf(unit)
    const notSent = !unit.response
    const { tests: suiteTests, failures, errors: suiteErrors } = suiteCounts(unit)
    const time = sec(unit.durationMs)

    const out: string[] = [
      `  <testsuite name="${escapeAttr(unit.path)}" tests="${suiteTests}" failures="${failures}" errors="${suiteErrors}" time="${time}">`
    ]
    if (notSent) {
      out.push(
        `    <testcase name="request not sent" classname="${escapeAttr(classname)}" time="${time}">`
      )
      out.push(
        `      <error message="${escapeAttr(unit.error ?? 'the request produced no response')}" type="TransportError"/>`
      )
      out.push(`    </testcase>`)
    }
    for (const t of unit.tests) {
      if (t.passed) {
        out.push(
          `    <testcase name="${escapeAttr(t.name)}" classname="${escapeAttr(classname)}" time="${time}"/>`
        )
      } else {
        out.push(
          `    <testcase name="${escapeAttr(t.name)}" classname="${escapeAttr(classname)}" time="${time}">`
        )
        out.push(
          `      <failure message="${escapeAttr(t.error ?? 'assertion failed')}" type="AssertionError"/>`
        )
        out.push(`    </testcase>`)
      }
    }
    for (const e of scriptErrs) {
      out.push(
        `    <testcase name="script error" classname="${escapeAttr(classname)}" time="${time}">`
      )
      out.push(
        `      <error message="${escapeAttr(e.message)}" type="ScriptError">${escapeXml(e.stack ?? '')}</error>`
      )
      out.push(`    </testcase>`)
    }
    out.push(`  </testsuite>`)
    return out
  }
}
