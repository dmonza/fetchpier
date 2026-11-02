import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { XMLParser } from 'fast-xml-parser'
import { JsonReporter } from '../../src/reporters/json'
import { JunitReporter } from '../../src/reporters/junit'
import { HtmlReporter } from '../../src/reporters/html'
import { createReporters } from '../../src/reporters'
import type { RequestUnit, RunSummary } from '../../src/types'

const passing: RequestUnit = {
  type: 'request',
  path: 'auth/login.http',
  name: 'POST https://api.example.com/auth/login',
  request: {
    method: 'POST',
    url: 'https://api.example.com/auth/login',
    headers: { Authorization: 'Bearer [REDACTED]' },
    body: '{"u":"a"}'
  },
  response: {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' },
    body: '{"token":"x"}',
    timingMs: 142,
    sizeBytes: 1234
  },
  scripts: {},
  tests: [{ name: 'status is 2xx', passed: true }],
  durationMs: 158
}

const failing: RequestUnit = {
  type: 'request',
  path: 'users/get.http',
  name: 'GET https://api.example.com/users/<script>',
  request: { method: 'GET', url: 'https://api.example.com/users', headers: {} },
  response: {
    status: 404,
    statusText: 'Not Found',
    headers: {},
    body: '<script>alert(1)</script>',
    timingMs: 89,
    sizeBytes: 45
  },
  scripts: { postResponse: { logs: [], errors: [{ message: 'boom & <bad>' }] } },
  tests: [{ name: 'has id', passed: false, error: 'expected undefined to be a string' }],
  durationMs: 89
}

function summary(units: RequestUnit[]): RunSummary {
  const tests = units.flatMap((u) => u.tests)
  const scriptErrors = units.reduce(
    (n, u) =>
      n + (u.scripts.postResponse?.errors.length ?? 0) + (u.scripts.preRequest?.errors.length ?? 0),
    0
  )
  return {
    schemaVersion: '1.0',
    fetchpier: { cliVersion: '0.9.0' },
    workspace: '/tmp/ws',
    environment: 'staging',
    startedAt: '2026-05-22T18:42:15.234Z',
    endedAt: '2026-05-22T18:42:15.889Z',
    durationMs: 655,
    summary: {
      requests: {
        total: units.length,
        passed: units.filter((u) => u.tests.every((t) => t.passed)).length,
        failed: units.filter((u) => u.tests.some((t) => !t.passed)).length
      },
      tests: {
        total: tests.length,
        passed: tests.filter((t) => t.passed).length,
        failed: tests.filter((t) => !t.passed).length
      },
      scriptErrors
    },
    units
  }
}

let dir: string
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})
function tmpFile(name: string): string {
  dir = mkdtempSync(join(tmpdir(), 'fp-rep-'))
  return join(dir, name)
}

describe('JSON reporter', () => {
  it('writes a schema-1.0 document matching RunSummary', async () => {
    const file = tmpFile('out.json')
    const r = new JsonReporter({ output: file })
    const s = summary([passing, failing])
    r.runComplete(s)
    await r.finalize()
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as RunSummary
    expect(parsed.schemaVersion).toBe('1.0')
    expect(parsed.fetchpier.cliVersion).toBe('0.9.0')
    expect(parsed.summary.tests).toEqual({ total: 2, passed: 1, failed: 1 })
    expect(parsed.units[0].response?.body).toBe('{"token":"x"}')
    expect(parsed.units[0].request.headers.Authorization).toBe('Bearer [REDACTED]')
  })

  it('omits bodies with noBody', async () => {
    const file = tmpFile('nobody.json')
    const r = new JsonReporter({ output: file, noBody: true })
    r.runComplete(summary([passing]))
    await r.finalize()
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as RunSummary
    expect(parsed.units[0].response?.body).toBe('')
  })

  it('writes to stdout for output "-"', async () => {
    let out = ''
    const r = new JsonReporter({ output: '-', write: (s) => (out += s) })
    r.runComplete(summary([passing]))
    await r.finalize()
    expect(JSON.parse(out).schemaVersion).toBe('1.0')
  })
})

describe('JUnit reporter', () => {
  it('emits valid XML with failures and errors', async () => {
    const file = tmpFile('out.xml')
    const r = new JunitReporter({ output: file })
    r.runComplete(summary([passing, failing]))
    await r.finalize()
    const xml = readFileSync(file, 'utf-8')
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' })
    const doc = parser.parse(xml)
    // The root aggregates what the suites emit. It previously read the run
    // summary instead, where a script error counts as one *unit*, while a suite
    // emits one case per error *entry* — so the root disagreed with the sum of
    // its children (it said 2 where the suites summed to 3).
    expect(doc.testsuites['@_tests']).toBe('3')
    expect(doc.testsuites['@_failures']).toBe('1')
    expect(doc.testsuites['@_errors']).toBe('1')

    const suites = Array.isArray(doc.testsuites.testsuite)
      ? doc.testsuites.testsuite
      : [doc.testsuites.testsuite]
    const sum = (attr: string): number =>
      suites.reduce((n: number, s: Record<string, string>) => n + Number(s[attr]), 0)
    expect(Number(doc.testsuites['@_tests'])).toBe(sum('@_tests'))
    expect(Number(doc.testsuites['@_failures'])).toBe(sum('@_failures'))
    expect(Number(doc.testsuites['@_errors'])).toBe(sum('@_errors'))
    // The failing assertion message escapes raw text and round-trips.
    expect(xml).toContain(
      '<failure message="expected undefined to be a string" type="AssertionError"/>'
    )
    expect(xml).toContain('type="ScriptError"')
    // No raw unescaped ampersand from the script-error message.
    expect(xml).toContain('boom &amp; &lt;bad&gt;')
  })
})

describe('HTML reporter', () => {
  it('produces a standalone, offline, XSS-safe document', async () => {
    const file = tmpFile('out.html')
    const r = new HtmlReporter({ output: file })
    r.runComplete(summary([passing, failing]))
    await r.finalize()
    const html = readFileSync(file, 'utf-8')
    expect(html).toContain('<!doctype html>')
    expect(html).not.toContain('http://') // no CDN/external links
    expect(html).not.toContain('https://cdn')
    expect(html).toContain('id="theme"')
    expect(html).toContain('id="filter"')
    // The malicious response body must be escaped, not live.
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>alert(1)</script>')
  })

  it('starts filtered with onlyFailures', async () => {
    const file = tmpFile('filtered.html')
    const r = new HtmlReporter({ output: file, onlyFailures: true })
    r.runComplete(summary([passing, failing]))
    await r.finalize()
    expect(readFileSync(file, 'utf-8')).toContain('<body class="only-failures">')
  })
})

describe('reporter factory', () => {
  it('throws exit 2 when the output directory does not exist', () => {
    expect(() =>
      createReporters([{ type: 'json', output: '/no/such/dir/out.json' }], {
        ascii: true,
        noColor: true,
        silent: true,
        showSecrets: false
      })
    ).toThrowError(/directory does not exist/)
  })

  it('silences the CLI reporter when JSON goes to stdout', () => {
    const reporters = createReporters([{ type: 'cli' }, { type: 'json', output: '-' }], {
      ascii: true,
      noColor: true,
      silent: false,
      showSecrets: false
    })
    expect(reporters).toHaveLength(2)
  })

  // Only the JSON reporter implements stdout. Accepting `-` for the others
  // produced a file named literally `-` in the working directory: the caller
  // asked for stdout and silently got a stray file.
  it.each(['junit', 'html'] as const)('rejects stdout for the %s reporter', (type) => {
    expect(() =>
      createReporters([{ type, output: '-' }], {
        ascii: true,
        noColor: true,
        silent: true,
        showSecrets: false
      })
    ).toThrowError(/cannot write to stdout/)
  })
})
