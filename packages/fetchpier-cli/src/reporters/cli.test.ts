import { describe, it, expect } from 'vitest'
import { Chalk } from 'chalk'
import { CliReporter } from './cli'
import { ASCII_GLYPHS, UNICODE_GLYPHS } from '../output/glyphs'
import type { RequestUnit, RunSummary } from '../types'
import type { RunMeta, UnitStart } from './types'

const NO_COLOR = new Chalk({ level: 0 })

interface Captured {
  out: string
  err: string
}

function render(
  meta: Pick<RunMeta, 'workspace' | 'environment' | 'plannedUnits'>,
  units: RequestUnit[],
  summary: RunSummary,
  ascii = true
): Captured {
  let out = ''
  let err = ''
  const reporter = new CliReporter({
    glyphs: ascii ? ASCII_GLYPHS : UNICODE_GLYPHS,
    colors: NO_COLOR,
    write: (l) => (out += l),
    writeErr: (l) => (err += l)
  })
  reporter.runStart({
    ...meta,
    cliVersion: '0.9.0',
    startedAt: '2026-05-22T00:00:00.000Z',
    verbosity: 0,
    showSecrets: false
  })
  for (const u of units) {
    const start: UnitStart = {
      path: u.path,
      name: u.name,
      method: u.request.method,
      urlTemplate: u.path.includes('login') ? '{{baseUrl}}/auth/login' : u.request.url
    }
    reporter.unitStart(start)
    reporter.unitComplete(u)
  }
  reporter.runComplete(summary)
  reporter.finalize()
  return { out, err }
}

function summaryOf(units: RequestUnit[], scriptErrors: number, durationMs: number): RunSummary {
  let passed = 0
  let failed = 0
  let rPassed = 0
  let rFailed = 0
  for (const u of units) {
    const f = u.tests.filter((t) => !t.passed).length
    passed += u.tests.length - f
    failed += f
    const bad =
      f > 0 ||
      !u.response ||
      (u.scripts.preRequest?.errors.length ?? 0) > 0 ||
      (u.scripts.postResponse?.errors.length ?? 0) > 0
    if (bad) rFailed++
    else rPassed++
  }
  return {
    schemaVersion: '1.0',
    fetchpier: { cliVersion: '0.9.0' },
    workspace: '/tmp/ws',
    environment: 'default',
    startedAt: '2026-05-22T00:00:00.000Z',
    endedAt: '2026-05-22T00:00:00.000Z',
    durationMs,
    summary: {
      requests: { total: units.length, passed: rPassed, failed: rFailed },
      tests: { total: passed + failed, passed, failed },
      scriptErrors
    },
    units
  }
}

const okUnit: RequestUnit = {
  type: 'request',
  path: 'auth/login.http',
  name: 'POST https://api.example.com/auth/login',
  request: { method: 'POST', url: 'https://api.example.com/auth/login', headers: {} },
  response: {
    status: 200,
    statusText: 'OK',
    headers: {},
    body: '{}',
    timingMs: 142,
    sizeBytes: 1234
  },
  scripts: {},
  tests: [
    { name: 'status is 2xx', passed: true },
    { name: 'response has token', passed: true }
  ],
  durationMs: 158
}

describe('CliReporter — single request', () => {
  it('renders the passing block (ASCII)', () => {
    const { out } = render(
      { workspace: '/tmp/ws', environment: 'default', plannedUnits: 1 },
      [okUnit],
      summaryOf([okUnit], 0, 158)
    )
    expect(out).toBe(
      [
        'Workspace: /tmp/ws',
        'Environment: default',
        '',
        '> POST {{baseUrl}}/auth/login',
        '  -> POST https://api.example.com/auth/login',
        '  <- 200 OK - 142ms - 1.2KB',
        '  Tests:',
        '    [OK] status is 2xx',
        '    [OK] response has token',
        '    2 passed',
        '',
        '[OK] 1 request, 2 tests passed (158ms)',
        ''
      ].join('\n')
    )
  })

  it('renders a failing test with its assertion message', () => {
    const unit: RequestUnit = {
      ...okUnit,
      response: {
        ...okUnit.response!,
        status: 404,
        statusText: 'Not Found',
        sizeBytes: 45,
        timingMs: 89
      },
      tests: [
        {
          name: 'status is 2xx',
          passed: false,
          error: 'AssertionError: expected 404 to be within range [200, 299]'
        },
        { name: 'response has error message', passed: true }
      ]
    }
    const { out } = render(
      { workspace: '/tmp/ws', environment: 'default', plannedUnits: 1 },
      [unit],
      summaryOf([unit], 0, 104)
    )
    expect(out).toContain('  <- 404 Not Found - 89ms - 45B')
    expect(out).toContain('    [FAIL] status is 2xx')
    expect(out).toContain('        AssertionError: expected 404 to be within range [200, 299]')
    expect(out).toContain('    1 passed, 1 failed')
    expect(out).toContain('[FAIL] 1 request, 1 of 2 tests failed (104ms)')
  })

  it('renders a pre-request script error with "request not sent"', () => {
    const unit: RequestUnit = {
      type: 'request',
      path: 'users/create.http',
      name: 'POST https://api/users',
      request: { method: 'POST', url: 'https://api/users', headers: {} },
      response: undefined,
      scripts: {
        preRequest: {
          logs: [],
          errors: [{ message: "Error: cannot read property 'token' of undefined", line: 3 }]
        }
      },
      tests: [],
      durationMs: 12
    }
    const { out } = render(
      { workspace: '/tmp/ws', environment: 'default', plannedUnits: 1 },
      [unit],
      summaryOf([unit], 1, 12)
    )
    expect(out).toContain('  pre-request script:')
    expect(out).toContain("    [FAIL] Error: cannot read property 'token' of undefined")
    expect(out).toContain('        at line 3')
    expect(out).toContain('  request not sent')
    expect(out).toContain('[FAIL] 1 request, 1 not sent, 0 tests, 1 script error (12ms)')
  })

  // REQ-0111: a run whose service was unreachable used to print a green tick and
  // "1 request, 0 tests" — the footer read as success because it only consulted
  // test and script counters.
  it('marks the footer failed and names the reason when the request could not be sent', () => {
    const unit: RequestUnit = {
      type: 'request',
      path: 'users/list.http',
      name: 'GET https://api/users',
      request: { method: 'GET', url: 'https://api/users', headers: {} },
      response: undefined,
      scripts: {},
      tests: [],
      error: 'connect ECONNREFUSED 127.0.0.1:9',
      durationMs: 14
    }
    const { out } = render(
      { workspace: '/tmp/ws', environment: 'default', plannedUnits: 1 },
      [unit],
      summaryOf([unit], 0, 14)
    )
    expect(out).toContain('  request not sent: connect ECONNREFUSED 127.0.0.1:9')
    expect(out).toContain('[FAIL] 1 request, 1 not sent, 0 tests (14ms)')
    expect(out).not.toContain('[PASS] 1 request')
  })

  it('shows a script-ran-no-output line when scripts exist without logs', () => {
    const unit: RequestUnit = {
      ...okUnit,
      scripts: {
        preRequest: { logs: [], errors: [] },
        postResponse: { logs: [], errors: [] }
      },
      tests: [{ name: 'status is 201', passed: true }]
    }
    const { out } = render(
      { workspace: '/tmp/ws', environment: 'default', plannedUnits: 1 },
      [unit],
      summaryOf([unit], 0, 240)
    )
    expect(out).toContain('  pre-request script: ran (no output)')
    expect(out).toContain('  post-response script: ran (no output)')
  })

  it('uses Unicode glyphs by default', () => {
    const { out } = render(
      { workspace: '/tmp/ws', environment: 'default', plannedUnits: 1 },
      [okUnit],
      summaryOf([okUnit], 0, 158),
      false
    )
    expect(out).toContain('▶ POST')
    expect(out).toContain('  → POST')
    expect(out).toContain('  ← 200 OK · 142ms · 1.2KB')
    expect(out).toContain('    ✓ status is 2xx')
    expect(out).toContain('✓ 1 request, 2 tests passed (158ms)')
  })
})

describe('CliReporter — multiple requests', () => {
  it('renders compact lines and a Failures section', () => {
    const a: RequestUnit = {
      ...okUnit,
      path: 'auth/login.http',
      request: { method: 'POST', url: 'https://api.example.com/auth/login', headers: {} }
    }
    const b: RequestUnit = {
      type: 'request',
      path: 'users/orders/create.http',
      name: 'POST https://api.example.com/users/4521/orders',
      request: { method: 'POST', url: 'https://api.example.com/users/4521/orders', headers: {} },
      response: {
        status: 201,
        statusText: 'Created',
        headers: {},
        body: '{}',
        timingMs: 312,
        sizeBytes: 156
      },
      scripts: {},
      tests: [
        { name: 'status is 201', passed: true },
        { name: 'response has order id', passed: false, error: 'expected undefined to be a string' }
      ],
      durationMs: 312
    }
    const { out } = render(
      { workspace: '/tmp/ws', environment: 'staging', plannedUnits: 2 },
      [a, b],
      summaryOf([a, b], 0, 655)
    )
    expect(out).toContain('> POST /auth/login')
    expect(out).toContain('<- 200 OK - 142ms - 1.2KB - [OK] 2/2 tests')
    expect(out).toContain('<- 201 Created - 312ms - 156B - [FAIL] 1/2 tests')
    expect(out).toContain('Failures:')
    expect(out).toContain('  POST /users/4521/orders')
    expect(out).toContain('    [FAIL] response has order id')
    expect(out).toContain('        expected undefined to be a string')
    expect(out).toContain('        at users/orders/create.http')
    expect(out).toContain('[FAIL] 2 requests, 3 of 4 tests passed, 1 failed (655ms)')
  })
})
