import { describe, it, expect } from 'vitest'
import { createColors } from '../output/colors'
import { CliReporter } from './cli'
import { ASCII_GLYPHS, UNICODE_GLYPHS } from '../output/glyphs'
import type { RequestUnit, RunSummary } from '../types'
import type { RunMeta, UnitStart } from './types'

const NO_COLOR = createColors({ noColor: true })

interface Captured {
  out: string
  err: string
}

function render(
  meta: Pick<RunMeta, 'workspace' | 'environment' | 'plannedUnits'> &
    Partial<Pick<RunMeta, 'environmentName' | 'verbosity' | 'proxy'>>,
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
    environmentName: meta.environment,
    verbosity: 0,
    ...meta,
    cliVersion: '0.9.0',
    startedAt: '2026-05-22T00:00:00.000Z',
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

  it('renders a pre-request script error as "not run" — no send was attempted', () => {
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
    expect(out).toContain('  not run')
    expect(out).not.toContain('request not sent')
    expect(out).toContain('[FAIL] 1 request, 1 not run, 0 tests, 1 script error (12ms)')
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
    expect(out).toContain('  no response: connect ECONNREFUSED 127.0.0.1:9')
    expect(out).toContain('[FAIL] 1 request, 1 no response, 0 tests (14ms)')
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

// ── CLI readiness: header, script output in multi runs, verbosity levels ──────

const detailUnit = (path: string, body = '{"ok":true}'): RequestUnit => ({
  ...okUnit,
  path,
  request: {
    method: 'POST',
    url: 'https://api.example.com/auth/login?x=1',
    headers: { 'Content-Type': 'application/json' },
    body: '{"user":"a"}'
  },
  response: { ...okUnit.response!, headers: { 'X-Trace': 'abc' }, body },
  scripts: { postResponse: { logs: [{ level: 'log', message: 'captured token' }], errors: [] } }
})

describe('CliReporter — header', () => {
  it('shows the environment by folder name and the active proxy without credentials', () => {
    const { out } = render(
      {
        workspace: '/tmp/ws',
        environment: '6f1c0b2e-0000-4000-8000-000000000000',
        environmentName: 'staging',
        plannedUnits: 1,
        proxy: { display: 'http://proxy:3128', source: 'HTTPS_PROXY' }
      },
      [okUnit],
      summaryOf([okUnit], 0, 158)
    )
    expect(out).toContain('Environment: staging\n')
    expect(out).not.toContain('6f1c0b2e')
    expect(out).toContain('Proxy: http://proxy:3128 (from HTTPS_PROXY)\n')
  })
})

describe('CliReporter — multi-request runs and verbosity', () => {
  const units = [detailUnit('a.http'), detailUnit('b.http')]
  const run = (verbosity: 0 | 1 | 2 | 3, u = units): string =>
    render(
      { workspace: '/tmp/ws', environment: 'default', plannedUnits: 2, verbosity },
      u,
      summaryOf(u, 0, 10)
    ).out

  it('default: script output is indented under each request line, nothing more', () => {
    const out = run(0)
    expect(out.match(/ {6}\[log\] captured token/g)).toHaveLength(2)
    expect(out).toContain('> POST /auth/login?x=1')
    expect(out).not.toContain('Tests:')
    expect(out).not.toContain('X-Trace')
  })

  it('-v: adds the test list and the full URL', () => {
    const out = run(1)
    expect(out).toContain('> POST https://api.example.com/auth/login?x=1')
    expect(out).toContain('    Tests:')
    expect(out).toContain('      [OK] status is 2xx')
    expect(out).not.toContain('X-Trace')
  })

  it('-vv: adds request and response headers, no bodies', () => {
    const out = run(2)
    expect(out).toContain('Content-Type: application/json')
    expect(out).toContain('X-Trace: abc')
    expect(out).not.toContain('{"user":"a"}')
  })

  it('-vvv: adds bodies, cut at 64 KB with a notice', () => {
    expect(run(3)).toContain('{"user":"a"}')
    const big = [detailUnit('big.http', 'y'.repeat(70 * 1024)), detailUnit('c.http')]
    const out = run(3, big)
    expect(out).toContain('… (truncated: 70KB total; use --reporter-json for the full body)')
    expect(out).not.toContain('y'.repeat(65 * 1024))
  })

  it('a single-request run shows headers at -vv too', () => {
    const out = render(
      { workspace: '/tmp/ws', environment: 'default', plannedUnits: 1, verbosity: 2 },
      [detailUnit('a.http')],
      summaryOf([detailUnit('a.http')], 0, 10)
    ).out
    expect(out).toContain('    Content-Type: application/json')
    expect(out).toContain('    X-Trace: abc')
  })

  it('labels a file with no request "not run" and an unreachable one "no response"', () => {
    const noRequest: RequestUnit = {
      type: 'request',
      path: 'empty.http',
      name: 'empty.http',
      request: { method: '', url: 'empty.http', headers: {} },
      scripts: {},
      tests: [],
      error: 'no request found in this file',
      durationMs: 0
    }
    const unreachable: RequestUnit = {
      ...noRequest,
      path: 'down.http',
      request: { method: 'GET', url: 'http://127.0.0.1:9/', headers: {} },
      error: 'timed out after 30 s'
    }
    const out = run(0, [noRequest, unreachable])
    expect(out).toContain('not run: no request found in this file')
    expect(out).toContain('no response: timed out after 30 s')
    expect(out).toContain('1 no response, 1 not run')
  })

  it('shows compressed and decoded sizes for a decoded response', () => {
    const u: RequestUnit = {
      ...okUnit,
      response: {
        ...okUnit.response!,
        sizeBytes: 8192,
        compressedBytes: 1024,
        decompressedBytes: 8192,
        decodingStatus: 'decoded'
      }
    }
    const out = render(
      { workspace: '/tmp/ws', environment: 'default', plannedUnits: 1 },
      [u],
      summaryOf([u], 0, 1)
    ).out
    expect(out).toContain('1KB (8KB decoded)')
  })
})

// ── CLI hardening: binary bodies, proxy visibility, engine-reported not-run ───

describe('CliReporter — CLI hardening', () => {
  const single = (u: RequestUnit, extra: Partial<RunMeta> = {}): string =>
    render(
      { workspace: '/tmp/ws', environment: 'default', plannedUnits: 1, ...extra },
      [u],
      summaryOf([u], 0, 1)
    ).out

  it('-vvv prints a binary response body as one placeholder line, never its bytes', () => {
    const png = String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0, 0, 0xff)
    const u: RequestUnit = {
      ...okUnit,
      response: { ...okUnit.response!, headers: { 'Content-Type': 'image/png' }, body: png }
    }
    const out = single(u, { verbosity: 3 })
    expect(out).toMatch(/<binary body: \d+B, image\/png — use --reporter-json for the full body>/)
    expect(out).not.toContain('PNG')
  })

  it('-vvv prints a decoded compressed text body as text despite its Content-Encoding header', () => {
    const u: RequestUnit = {
      ...okUnit,
      response: {
        ...okUnit.response!,
        headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
        body: '{"decoded":true}',
        decodingStatus: 'decoded'
      }
    }
    expect(single(u, { verbosity: 3 })).toContain('{"decoded":true}')
  })

  it('the proxy header names the NO_PROXY list', () => {
    const out = single(okUnit, {
      proxy: { display: 'http://proxy:3128', source: 'HTTPS_PROXY', noProxy: '.internal.test' }
    })
    expect(out).toContain('Proxy: http://proxy:3128 (from HTTPS_PROXY; NO_PROXY: .internal.test)')
  })

  it('-v states via proxy or direct per request; the default level does not', () => {
    const viaProxy: RequestUnit = { ...okUnit, via: 'proxy' }
    const direct: RequestUnit = { ...okUnit, path: 'b.http', via: 'direct' }
    const verbose = render(
      { workspace: '/tmp/ws', environment: 'default', plannedUnits: 2, verbosity: 1 },
      [viaProxy, direct],
      summaryOf([viaProxy, direct], 0, 1)
    ).out
    expect(verbose).toContain('(via proxy)')
    expect(verbose).toContain('(direct)')
    expect(single(viaProxy)).not.toContain('(via proxy)')
  })

  it('a unit the engine marked notRun reads "not run" (e.g. a missing binary file)', () => {
    const u: RequestUnit = {
      ...okUnit,
      response: undefined,
      tests: [],
      error: 'binary file not found: photo.png',
      notRun: true
    }
    expect(single(u)).toContain('not run: binary file not found: photo.png')
  })
})
