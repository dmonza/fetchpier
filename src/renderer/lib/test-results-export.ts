import type { ScriptResultsBundle } from '../../shared/types'

export interface ExportContext {
  requestName: string
  url: string
  timestamp: string
}

export function toJson(bundle: ScriptResultsBundle, context: ExportContext): string {
  const { requestName, url, timestamp } = context

  const serializePhase = (
    phase: ScriptResultsBundle['preRequest'] | ScriptResultsBundle['postResponse']
  ) => {
    if (!phase) return undefined
    const total = phase.testResults.length
    const passed = phase.testResults.filter((t) => t.passed).length
    return {
      success: phase.success,
      error: phase.error ?? null,
      tests: phase.testResults.map((t) => ({
        name: t.name,
        passed: t.passed,
        error: t.error ?? null
      })),
      summary: { total, passed, failed: total - passed }
    }
  }

  const pre = serializePhase(bundle.preRequest)
  const post = serializePhase(bundle.postResponse)

  const allTests = [
    ...(bundle.preRequest?.testResults ?? []),
    ...(bundle.postResponse?.testResults ?? [])
  ]
  const total = allTests.length
  const passed = allTests.filter((t) => t.passed).length

  const obj: Record<string, unknown> = {
    request: { name: requestName, url },
    timestamp,
    summary: { total, passed, failed: total - passed }
  }
  if (pre !== undefined) obj.preRequest = pre
  if (post !== undefined) obj.postResponse = post

  return JSON.stringify(obj, null, 2)
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function toJUnitXml(bundle: ScriptResultsBundle, context: ExportContext): string {
  const { requestName, timestamp } = context

  const buildSuite = (
    phase: ScriptResultsBundle['preRequest'] | ScriptResultsBundle['postResponse'],
    suffix: string
  ): string => {
    if (!phase) return ''
    const tests = phase.testResults
    const failures = tests.filter((t) => !t.passed).length
    const suiteName = escapeXml(`${requestName} (${suffix})`)
    const cases = tests
      .map((t) => {
        const name = escapeXml(t.name)
        if (t.passed) {
          return `    <testcase name="${name}" time="0"/>`
        }
        const msg = escapeXml(t.error ?? 'assertion failed')
        return `    <testcase name="${name}" time="0">\n      <failure message="${msg}"/>\n    </testcase>`
      })
      .join('\n')
    return `  <testsuite name="${suiteName}" tests="${tests.length}" failures="${failures}" timestamp="${escapeXml(timestamp)}">\n${cases}\n  </testsuite>`
  }

  const suites = [
    buildSuite(bundle.preRequest, 'pre-request'),
    buildSuite(bundle.postResponse, 'post-response')
  ]
    .filter(Boolean)
    .join('\n')

  const allTests = [
    ...(bundle.preRequest?.testResults ?? []),
    ...(bundle.postResponse?.testResults ?? [])
  ]
  const total = allTests.length
  const failures = allTests.filter((t) => !t.passed).length

  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="${escapeXml(requestName)}" tests="${total}" failures="${failures}">\n${suites}\n</testsuites>`
}
