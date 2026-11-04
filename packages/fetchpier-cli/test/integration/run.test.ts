import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getLocal, type Mockttp } from 'mockttp'
import { executeRun } from '../../src/commands/request/run'
import { runAction } from '../../src/commands/request/index'
import { setRunSignal } from '../../src/runtime-signal'
import { EXIT } from '../../src/exit-codes'

/**
 * A port that was just bound and released — reliably closed, so connecting to
 * it refuses rather than hanging. Preferred over a hardcoded port number, which
 * could be in use on a developer machine or in CI.
 */
async function closedPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo
      srv.close(() => resolve(port))
    })
  })
}

let server: Mockttp

beforeAll(async () => {
  server = getLocal()
  await server.start()
  await server.forGet('/users').thenJson(200, { users: [{ id: 1, name: 'Ada' }] })
  await server.forGet('/missing').thenReply(404, 'nope')
})

afterAll(async () => {
  await server.stop()
})

const workspaces: string[] = []
afterEach(() => {
  for (const ws of workspaces.splice(0)) rmSync(ws, { recursive: true, force: true })
})

function makeWorkspace(
  requestFiles: Record<string, string>,
  vars: Record<string, string> = {}
): string {
  const ws = mkdtempSync(join(tmpdir(), 'fp-run-'))
  workspaces.push(ws)
  mkdirSync(join(ws, '.fetchpier'), { recursive: true })
  writeFileSync(join(ws, '.fetchpier', 'settings.json'), JSON.stringify({ version: 1 }))
  const envDir = join(ws, 'environments', 'default')
  mkdirSync(envDir, { recursive: true })
  writeFileSync(
    join(envDir, 'config.json'),
    JSON.stringify({ id: 'default', name: 'default', variables: { baseUrl: server.url, ...vars } })
  )
  for (const [rel, content] of Object.entries(requestFiles)) {
    const abs = join(ws, 'requests', rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
  }
  return ws
}

const silentCtx = { write: () => {}, writeErr: () => {} }
const deps = (ws: string): { reporterContext: typeof silentCtx; cwd: string } => ({
  reporterContext: silentCtx,
  cwd: ws
})

describe('executeRun (integration)', () => {
  it('runs a request, executes its post-response test, and reports a pass', async () => {
    const ws = makeWorkspace({
      'get-users.http': [
        'GET {{baseUrl}}/users',
        '',
        '# @post-response-script',
        "# fp.test('status is 200', () => { fp.expect(fp.response.status).to.equal(200) })",
        '# @end-script',
        ''
      ].join('\n')
    })

    const summary = await executeRun(
      { paths: ['requests/get-users.http'], workspace: ws },
      deps(ws)
    )

    expect(summary.summary.requests).toEqual({ total: 1, passed: 1, failed: 0 })
    expect(summary.summary.tests).toEqual({ total: 1, passed: 1, failed: 0 })
    expect(summary.summary.scriptErrors).toBe(0)
    expect(summary.units[0].response?.status).toBe(200)
    expect(summary.units[0].request.url).toBe(`${server.url}/users`)
  })

  it('counts a failed assertion as a test failure', async () => {
    const ws = makeWorkspace({
      'fail.http': [
        'GET {{baseUrl}}/missing',
        '',
        '# @post-response-script',
        "# fp.test('status is 2xx', () => { fp.expect(fp.response.status).to.be.below(300) })",
        '# @end-script',
        ''
      ].join('\n')
    })

    const summary = await executeRun({ paths: ['requests/fail.http'], workspace: ws }, deps(ws))
    expect(summary.summary.tests.failed).toBe(1)
    expect(summary.units[0].response?.status).toBe(404)
  })

  it('applies --env-var overrides over environment variables', async () => {
    const ws = makeWorkspace({ 'get.http': 'GET {{baseUrl}}{{path}}\n' }, { path: '/missing' })
    const summary = await executeRun(
      { paths: ['requests/get.http'], workspace: ws, envVars: { path: '/users' } },
      deps(ws)
    )
    expect(summary.units[0].request.url).toBe(`${server.url}/users`)
    expect(summary.units[0].response?.status).toBe(200)
  })

  // REQ-0087 CA-11: a dynamic variable resolves identically under the runner.
  it('resolves a dynamic {{$randomInt}} to an integer in 0…1000 on the wire', async () => {
    const ws = makeWorkspace({ 'dyn.http': 'GET {{baseUrl}}/users?n={{$randomInt}}\n' })
    const summary = await executeRun({ paths: ['requests/dyn.http'], workspace: ws }, deps(ws))
    expect(summary.units[0].response?.status).toBe(200)
    const n = Number(new URL(summary.units[0].request.url).searchParams.get('n'))
    expect(Number.isInteger(n)).toBe(true)
    expect(n).toBeGreaterThanOrEqual(0)
    expect(n).toBeLessThanOrEqual(1000)
  })

  it('runs every .http file in a folder when given the folder', async () => {
    const ws = makeWorkspace({
      'a.http': 'GET {{baseUrl}}/users\n',
      'sub/b.http': 'GET {{baseUrl}}/users\n'
    })
    const summary = await executeRun({ paths: ['requests'], workspace: ws }, deps(ws))
    expect(summary.summary.requests.total).toBe(2)
  })

  // REQ-0067 CA-06: parity desktop ↔ CLI for $env.* resolution.
  // The CLI must resolve {{$env.NAME}} against process.env (and .env when present)
  // BEFORE merging --env-var overrides.
  it('resolves {{$env.NAME}} from process.env when no .env file is present', async () => {
    const ws = makeWorkspace(
      { 'get.http': 'GET {{baseUrl}}{{authPath}}\n' },
      { authPath: '/{{$env.FP_TEST_PATH}}' }
    )
    const summary = await executeRun(
      { paths: ['requests/get.http'], workspace: ws },
      { ...deps(ws), env: { FP_TEST_PATH: 'users' } }
    )
    expect(summary.units[0].request.url).toBe(`${server.url}/users`)
    expect(summary.units[0].response?.status).toBe(200)
  })

  it('.env file wins over process.env for $env.* resolution', async () => {
    const ws = makeWorkspace(
      { 'get.http': 'GET {{baseUrl}}{{authPath}}\n' },
      { authPath: '/{{$env.FP_TEST_PATH}}' }
    )
    writeFileSync(join(ws, '.env'), 'FP_TEST_PATH=users\n')
    const summary = await executeRun(
      { paths: ['requests/get.http'], workspace: ws },
      { ...deps(ws), env: { FP_TEST_PATH: 'missing' } }
    )
    expect(summary.units[0].request.url).toBe(`${server.url}/users`)
  })

  it('missing $env.* key resolves to "" (CA-04 over CLI)', async () => {
    const ws = makeWorkspace(
      { 'get.http': 'GET {{baseUrl}}{{tail}}\n' },
      { tail: '/users{{$env.FP_TEST_MISSING}}' }
    )
    const summary = await executeRun(
      { paths: ['requests/get.http'], workspace: ws, showSecrets: true },
      { ...deps(ws), env: {} }
    )
    expect(summary.units[0].request.url).toBe(`${server.url}/users`)
  })

  it('CA-12: fp run does NOT create a missing .gitignore', async () => {
    const ws = makeWorkspace({ 'get.http': 'GET {{baseUrl}}/users\n' })
    // Pre-condition: no .gitignore in this freshly built workspace.
    expect(existsSync(join(ws, '.gitignore'))).toBe(false)
    await executeRun({ paths: ['requests/get.http'], workspace: ws }, deps(ws))
    // Post-condition: still no .gitignore. CLI must not repair workspaces.
    expect(existsSync(join(ws, '.gitignore'))).toBe(false)
  })

  // REQ-0086 CA-07: a malformed query key proceeds and warns; it does not fail the run.
  it('REQ-0086 CA-07: a malformed query key warns but does not fail the run', async () => {
    const errChunks: string[] = []
    const ws = makeWorkspace({ 'mal.http': 'GET {{baseUrl}}/users?%E0=x\n' })
    const summary = await executeRun(
      { paths: ['requests/mal.http'], workspace: ws },
      {
        reporterContext: { write: () => {}, writeErr: (s: string) => errChunks.push(s) },
        cwd: ws
      }
    )
    expect(summary.summary.requests.total).toBe(1)
    expect(summary.summary.requests.failed).toBe(0)
    expect(summary.units[0].response?.status).toBe(200)
    const stderr = errChunks.join('')
    expect(stderr).toContain('%E0')
    expect(stderr.toLowerCase()).toContain('could not be decoded')
  })

  it('stops after the first failure with bail', async () => {
    const ws = makeWorkspace({
      'a.http': [
        'GET {{baseUrl}}/missing',
        '',
        '# @post-response-script',
        "# fp.test('ok', () => { fp.expect(fp.response.status).to.equal(200) })",
        '# @end-script',
        ''
      ].join('\n'),
      'b.http': 'GET {{baseUrl}}/users\n'
    })
    const summary = await executeRun({ paths: ['requests'], workspace: ws, bail: true }, deps(ws))
    expect(summary.summary.requests.total).toBe(1)
  })

  // CLI-009 (unsent variant): a request with no response is a failure for bail
  // too — the same rule the summary and the exit code already apply.
  it('stops after a request that could not be sent with bail', async () => {
    const port = await closedPort()
    const ws = makeWorkspace(
      { 'a.http': 'GET {{deadUrl}}/users\n', 'b.http': 'GET {{baseUrl}}/users\n' },
      { deadUrl: `http://127.0.0.1:${port}` }
    )
    const summary = await executeRun({ paths: ['requests'], workspace: ws, bail: true }, deps(ws))
    expect(summary.summary.requests).toEqual({ total: 1, passed: 0, failed: 1 })
    expect(summary.units[0].path).toBe('requests/a.http')
  })
})

// CLI-095 — the no-path default is the workspace's `requests/` tree, from any
// current directory and any workspace resolution source. Every other spec in
// this file runs with cwd = workspace root, which is exactly why this gap went
// unnoticed.
describe('executeRun — no-path default from any directory (CLI-095)', () => {
  const FILES = {
    'list.http': 'GET {{baseUrl}}/users\n',
    'auth/login.http': 'GET {{baseUrl}}/users\n'
  }
  const ran = (paths: string[]): string[] => [...paths].sort()

  it('runs the whole requests/ tree from a workspace subfolder (discovery)', async () => {
    const ws = makeWorkspace(FILES)
    const summary = await executeRun(
      { paths: [] },
      { reporterContext: silentCtx, cwd: join(ws, 'requests', 'auth'), env: {} }
    )
    expect(summary.workspace).toBe(ws)
    expect(ran(summary.units.map((u) => u.path))).toEqual([
      'requests/auth/login.http',
      'requests/list.http'
    ])
  })

  it('runs the whole requests/ tree from outside with the workspace option', async () => {
    const ws = makeWorkspace(FILES)
    const summary = await executeRun(
      { paths: [], workspace: ws },
      { reporterContext: silentCtx, cwd: tmpdir(), env: {} }
    )
    expect(summary.summary.requests).toEqual({ total: 2, passed: 2, failed: 0 })
  })

  it('runs the whole requests/ tree from outside with the workspace environment variable', async () => {
    const ws = makeWorkspace(FILES)
    const summary = await executeRun(
      { paths: [] },
      { reporterContext: silentCtx, cwd: tmpdir(), env: { FETCHPIER_WORKSPACE: ws } }
    )
    expect(summary.summary.requests).toEqual({ total: 2, passed: 2, failed: 0 })
  })
})

// REQ-0111 — a request that cannot be sent is a run outcome, not a fatal
// condition. Before this, `executeRun` let the transport error escape: the
// binary classified it as an internal defect (exit 255 + stack trace + a
// bug-report invitation) and the run ended before any summary or report file
// was produced.
describe('executeRun — transport failures (REQ-0111)', () => {
  // CLI-080
  it('reports an unreachable service as a failed request instead of raising', async () => {
    const port = await closedPort()
    const ws = makeWorkspace(
      { 'dead.http': 'GET {{deadUrl}}/users\n' },
      {
        deadUrl: `http://127.0.0.1:${port}`
      }
    )

    const summary = await executeRun({ paths: ['requests/dead.http'], workspace: ws }, deps(ws))

    expect(summary.summary.requests).toEqual({ total: 1, passed: 0, failed: 1 })
    expect(summary.units[0].response).toBeUndefined()
    expect(summary.units[0].error).toBeTruthy()
  })

  // CLI-081
  it('reports an expired timeout as a failed request', async () => {
    await server.forGet('/slow').thenCallback(async () => {
      await new Promise((r) => setTimeout(r, 800))
      return { statusCode: 200, body: 'late' }
    })
    const ws = makeWorkspace({ 'slow.http': 'GET {{baseUrl}}/slow\n' })

    const summary = await executeRun(
      { paths: ['requests/slow.http'], workspace: ws, timeoutMs: 100 },
      deps(ws)
    )

    expect(summary.summary.requests.failed).toBe(1)
    expect(summary.units[0].response).toBeUndefined()
    expect(summary.units[0].error).toBeTruthy()
  })

  // CLI-082 — an interrupt in flight ends the run without a fatal error.
  it('ends cleanly when the run is interrupted mid-request', async () => {
    await server.forGet('/hang').thenCallback(async () => {
      await new Promise((r) => setTimeout(r, 800))
      return { statusCode: 200, body: 'late' }
    })
    const ws = makeWorkspace({ 'hang.http': 'GET {{baseUrl}}/hang\n' })
    const controller = new AbortController()

    const pending = executeRun(
      { paths: ['requests/hang.http'], workspace: ws, signal: controller.signal },
      deps(ws)
    )
    setTimeout(() => controller.abort(), 50)
    const summary = await pending

    expect(summary.summary.requests.failed).toBe(1)
    expect(summary.units[0].error).toBeTruthy()
  })

  // CLI-083 — the run that most needs a report is the one that used to produce none.
  it('writes every configured report when all requests failed', async () => {
    const port = await closedPort()
    const ws = makeWorkspace(
      { 'dead.http': 'GET {{deadUrl}}/users\n' },
      {
        deadUrl: `http://127.0.0.1:${port}`
      }
    )
    const jsonOut = join(ws, 'report.json')
    const junitOut = join(ws, 'report.xml')

    await executeRun(
      {
        paths: ['requests/dead.http'],
        workspace: ws,
        reporters: [
          { type: 'json', output: jsonOut },
          { type: 'junit', output: junitOut }
        ]
      },
      deps(ws)
    )

    expect(existsSync(jsonOut)).toBe(true)
    expect(existsSync(junitOut)).toBe(true)
  })

  // CLI-084 — the machine-readable report carries the reason; the schema version
  // does not move for an optional additive field.
  it('carries the failure reason into the JSON report without moving the schema version', async () => {
    const port = await closedPort()
    const ws = makeWorkspace(
      { 'dead.http': 'GET {{deadUrl}}/users\n' },
      {
        deadUrl: `http://127.0.0.1:${port}`
      }
    )
    const jsonOut = join(ws, 'report.json')

    await executeRun(
      {
        paths: ['requests/dead.http'],
        workspace: ws,
        reporters: [{ type: 'json', output: jsonOut }]
      },
      deps(ws)
    )

    const report = JSON.parse(readFileSync(jsonOut, 'utf-8'))
    expect(report.schemaVersion).toBe('1.0')
    expect(report.summary.requests.failed).toBe(1)
    expect(report.units[0].response).toBeUndefined()
    expect(typeof report.units[0].error).toBe('string')
    expect(report.units[0].error.length).toBeGreaterThan(0)
  })

  // CLI-093 — every case above targets `127.0.0.1`, a single address, and that
  // is precisely why they all passed while the product was silent: a host that
  // resolves to several addresses fails differently. When all of them are
  // refused the runtime aggregates the per-address causes and leaves its own
  // message empty, so a runner reading `.message` produced a unit that was
  // correctly counted as failed and carried no reason at all — `request not
  // sent` with nothing after it, and a generic sentence in the JUnit report.
  it('names the cause when every address of a multi-address host is refused', async () => {
    const port = await closedPort()
    const ws = makeWorkspace(
      { 'dead.http': 'GET {{deadUrl}}/users\n' },
      {
        // `localhost` resolves to both loopback families on a default install.
        deadUrl: `http://localhost:${port}`
      }
    )

    const summary = await executeRun({ paths: ['requests/dead.http'], workspace: ws }, deps(ws))

    expect(summary.summary.requests.failed).toBe(1)
    expect(summary.units[0].response).toBeUndefined()
    expect(summary.units[0].error).toBeTruthy()
    expect(summary.units[0].error).toContain('ECONNREFUSED')
  })

  // CLI-085 — the structured CI report derives its failure indicator from
  // assertion counts, so a request that never connected used to render as an
  // empty, passing suite: a green dashboard for a service that was down.
  it('renders a transport failure as a JUnit error rather than an empty passing suite', async () => {
    const port = await closedPort()
    const ws = makeWorkspace(
      { 'dead.http': 'GET {{deadUrl}}/users\n' },
      {
        deadUrl: `http://127.0.0.1:${port}`
      }
    )
    const junitOut = join(ws, 'report.xml')

    await executeRun(
      {
        paths: ['requests/dead.http'],
        workspace: ws,
        reporters: [{ type: 'junit', output: junitOut }]
      },
      deps(ws)
    )

    const xml = readFileSync(junitOut, 'utf-8')
    expect(xml).toContain('type="TransportError"')
    expect(xml).not.toMatch(/<testsuite [^>]*tests="0"[^>]*errors="0"/)
    expect(xml).toMatch(/<testsuites [^>]*errors="1"/)
  })
})

// REQ-0111 — the exit code has to consult failed requests. A run whose service
// was unreachable and which declared no assertions used to exit 0.
describe('runAction — exit codes for failed requests (REQ-0111)', () => {
  let previousExitCode: typeof process.exitCode

  beforeAll(() => {
    previousExitCode = process.exitCode
  })

  afterEach(() => {
    // Never leave a non-zero code behind: it would fail the whole test process.
    process.exitCode = previousExitCode
    // The interrupt case below aborts the module-level run signal, which is
    // process-wide state. Leaving it aborted made every later `runAction` exit
    // with the interrupt code regardless of its own outcome.
    setRunSignal(new AbortController().signal)
  })

  // CLI-086
  it('exits non-zero when a request failed even with no assertions declared', async () => {
    const port = await closedPort()
    const ws = makeWorkspace(
      { 'dead.http': 'GET {{deadUrl}}/users\n' },
      {
        deadUrl: `http://127.0.0.1:${port}`
      }
    )

    process.exitCode = 0
    await runAction([join(ws, 'requests', 'dead.http')], { workspace: ws, silent: true })

    expect(process.exitCode).toBe(EXIT.TEST_FAILURE)
  })

  // CLI-087
  it('still forces success when exit-code suppression is on', async () => {
    const port = await closedPort()
    const ws = makeWorkspace(
      { 'dead.http': 'GET {{deadUrl}}/users\n' },
      {
        deadUrl: `http://127.0.0.1:${port}`
      }
    )

    process.exitCode = 0
    await runAction([join(ws, 'requests', 'dead.http')], {
      workspace: ws,
      silent: true,
      suppressExitCode: true
    })

    expect(process.exitCode).toBe(0)
  })

  // CLI-088 — the interrupt branch existed but was unreachable: the transport
  // error escaped before the run could return and be inspected.
  it('exits with the interrupt code when the run is cancelled in flight', async () => {
    await server.forGet('/hang-exit').thenCallback(async () => {
      await new Promise((r) => setTimeout(r, 800))
      return { statusCode: 200, body: 'late' }
    })
    const ws = makeWorkspace({ 'hang.http': 'GET {{baseUrl}}/hang-exit\n' })
    const controller = new AbortController()
    setRunSignal(controller.signal)

    process.exitCode = 0
    const pending = runAction([join(ws, 'requests', 'hang.http')], { workspace: ws, silent: true })
    setTimeout(() => controller.abort(), 50)
    await pending

    expect(process.exitCode).toBe(EXIT.SIGINT)
  })
})

// A `.http` the runner was asked to execute that yields no request used to
// contribute nothing at all: "0 requests", exit 0, no warning — a run whose
// files were all unparseable reported success.
describe('executeRun — files with no parseable request (CLI-091..092)', () => {
  // Every shape that legitimately parses to nothing. Each is a plausible file to
  // find in a workspace, and none of them used to be reported at all.
  const EMPTY_CASES: Record<string, string> = {
    'empty.http': '',
    'blank.http': ['', '', '   ', ''].join('\n'),
    'comments.http': ['# just a note', '# and another', ''].join('\n'),
    'separator.http': ['###', ''].join('\n')
  }

  // CLI-091
  it('reports a file with no request as a failed unit and warns', async () => {
    const errChunks: string[] = []
    const ws = makeWorkspace({ 'empty.http': '' })

    const summary = await executeRun(
      { paths: ['requests/empty.http'], workspace: ws },
      {
        reporterContext: { write: () => {}, writeErr: (s: string) => errChunks.push(s) },
        cwd: ws
      }
    )

    expect(summary.summary.requests).toEqual({ total: 1, passed: 0, failed: 1 })
    expect(summary.units[0].response).toBeUndefined()
    expect(summary.units[0].error).toContain('no request found')
    expect(errChunks.join('')).toContain('no request found')
  })

  it.each(Object.keys(EMPTY_CASES))('treats %s as a failed unit', async (name) => {
    const ws = makeWorkspace({ [name]: EMPTY_CASES[name] })
    const summary = await executeRun({ paths: [`requests/${name}`], workspace: ws }, deps(ws))
    expect(summary.summary.requests.failed).toBe(1)
  })

  it('keeps running the remaining files', async () => {
    const ws = makeWorkspace({
      'a-empty.http': '',
      'b-ok.http': 'GET {{baseUrl}}/users\n'
    })
    const summary = await executeRun({ paths: ['requests'], workspace: ws }, deps(ws))
    expect(summary.summary.requests).toEqual({ total: 2, passed: 1, failed: 1 })
  })

  // CLI-092
  it('exits non-zero for a run whose only file has no request', async () => {
    const ws = makeWorkspace({ 'empty.http': '' })
    const previous = process.exitCode
    process.exitCode = 0
    try {
      await runAction([join(ws, 'requests', 'empty.http')], { workspace: ws, silent: true })
      expect(process.exitCode).toBe(EXIT.TEST_FAILURE)
    } finally {
      process.exitCode = previous
    }
  })
})

// REQ-0111 follow-up — an unresolved `{{reference}}` used to be reported only
// through a process log line, which no adapter and no CI report can read.
describe('executeRun — unresolved references (CLI-089)', () => {
  it('warns about a reference with no value and still sends it literally', async () => {
    const errChunks: string[] = []
    const ws = makeWorkspace({ 'ghost.http': 'GET {{baseUrl}}/users?who={{ghostVar}}\n' })

    const summary = await executeRun(
      { paths: ['requests/ghost.http'], workspace: ws },
      {
        reporterContext: { write: () => {}, writeErr: (s: string) => errChunks.push(s) },
        cwd: ws
      }
    )

    expect(summary.summary.requests.failed).toBe(0)
    expect(summary.units[0].response?.status).toBe(200)
    expect(summary.units[0].request.url).toContain('%7B%7BghostVar%7D%7D')

    const stderr = errChunks.join('')
    expect(stderr).toContain('ghostVar')
    expect(stderr).toContain('has no value in this environment')
  })

  // CLI-090 — advisories are computed before the send, so they must survive one
  // that fails. They used to be discarded exactly when a run went wrong.
  it('still reports the unresolved reference when the request cannot be sent', async () => {
    const errChunks: string[] = []
    const port = await closedPort()
    const ws = makeWorkspace(
      { 'ghost-dead.http': 'GET {{deadUrl}}/x?who={{ghostVar}}\n' },
      { deadUrl: `http://127.0.0.1:${port}` }
    )

    const summary = await executeRun(
      { paths: ['requests/ghost-dead.http'], workspace: ws },
      {
        reporterContext: { write: () => {}, writeErr: (s: string) => errChunks.push(s) },
        cwd: ws
      }
    )

    expect(summary.summary.requests.failed).toBe(1)
    expect(summary.units[0].error).toBeTruthy()
    expect(errChunks.join('')).toContain('ghostVar')
  })
})
