/**
 * CLI readiness for continuous integration — the runner as a CI pipeline uses
 * it. Each case references its catalog entry (docs/TESTS.md, CLI-098…CLI-112);
 * the Given/When/Then lives there.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { getLocal, type Mockttp } from 'mockttp'
import { secrets } from '@fetchpier/core'
import { executeRun } from '../../src/commands/request/run'
import { CLI_VERSION } from '../../src/version'
import type { RunOptions, RunSummary } from '../../src/types'

let server: Mockttp
beforeAll(async () => {
  server = getLocal()
  await server.start()
})
afterAll(async () => {
  await server.stop()
})

const dirs: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function workspaceWith(
  files: Record<string, string>,
  variables: Record<string, string | null> = {},
  folder = 'default'
): string {
  const ws = mkdtempSync(join(tmpdir(), 'fp-ci-'))
  dirs.push(ws)
  mkdirSync(join(ws, '.fetchpier'), { recursive: true })
  writeFileSync(join(ws, '.fetchpier', 'settings.json'), JSON.stringify({ version: 1 }))
  const envDir = join(ws, 'environments', folder)
  mkdirSync(envDir, { recursive: true })
  writeFileSync(
    join(envDir, 'config.json'),
    JSON.stringify({
      id: '6f1c0b2e-1111-4000-8000-000000000001',
      name: folder,
      variables: { baseUrl: server.url, ...variables }
    })
  )
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(ws, 'requests', rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
  }
  return ws
}

async function withSecrets(ws: string): Promise<{ key: Uint8Array; fpk: string }> {
  const key = await secrets.generateWorkspaceKey()
  writeFileSync(
    join(ws, '.fetchpier', 'secrets.json'),
    secrets.serializeManifest(await secrets.buildManifest(key))
  )
  return { key, fpk: secrets.formatKey(key) }
}

function setEnvVariables(ws: string, variables: Record<string, string | null>): void {
  const file = join(ws, 'environments', 'default', 'config.json')
  const config = JSON.parse(readFileSync(file, 'utf-8'))
  config.variables = { ...config.variables, ...variables }
  writeFileSync(file, JSON.stringify(config))
}

const script = (phase: 'pre-request' | 'post-response', ...lines: string[]): string =>
  [`# @${phase}-script`, ...lines.map((l) => `# ${l}`), '# @end-script', ''].join('\n')

interface Captured {
  summary: RunSummary
  out: string
  err: string
}

async function run(
  ws: string,
  options: Partial<RunOptions> = {},
  env: NodeJS.ProcessEnv = {}
): Promise<Captured> {
  let out = ''
  let err = ''
  const summary = await executeRun(
    { paths: [], workspace: ws, ...options },
    {
      cwd: ws,
      env,
      reporterContext: { write: (l: string) => (out += l), writeErr: (l: string) => (err += l) }
    }
  )
  return { summary, out, err }
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true }).map(String).sort()
}

describe('CLI readiness — variables across requests', () => {
  // CLI-098
  it('a token captured by a login reaches the next request, and nothing is written', async () => {
    await server.forPost('/login').thenJson(200, { token: 'jwt-abc' })
    const me = await server.forGet('/me').thenJson(200, { ok: true })
    const ws = workspaceWith({
      '01-login.http':
        script('post-response', 'fp.environment.set("token", fp.response.json().token)') +
        '\nPOST {{baseUrl}}/login\n',
      '02-me.http': 'GET {{baseUrl}}/me\nAuthorization: Bearer {{token}}\n'
    })
    const before = filesUnder(join(ws, 'environments'))

    const { summary } = await run(ws)

    expect(summary.summary.requests.failed).toBe(0)
    const [seen] = await me.getSeenRequests()
    expect(seen.headers.authorization).toBe('Bearer jwt-abc')
    expect(filesUnder(join(ws, 'environments'))).toEqual(before)
  })

  // CLI-099
  it('a script write wins over --env-var, and an unset is carried', async () => {
    const step = await server.forGet(/\/step\/.*/).thenReply(200, 'ok')
    const ws = workspaceWith({
      '01.http':
        script('post-response', 'fp.environment.set("token", "from-script")') +
        '\nGET {{baseUrl}}/step/{{token}}\n',
      '02.http':
        script('post-response', 'fp.environment.remove("token")') +
        '\nGET {{baseUrl}}/step/{{token}}\n',
      '03.http': 'GET {{baseUrl}}/step/{{token}}\n'
    })

    const { err } = await run(ws, { envVars: { token: 'from-flag' } })

    const paths = (await step.getSeenRequests()).map((r) => decodeURIComponent(r.path))
    expect(paths).toEqual(['/step/from-flag', '/step/from-script', '/step/{{token}}'])
    expect(err).toContain('variable "token" has no value')
  })

  // CLI-100
  it('a value written under a secret name stays masked in every output', async () => {
    const FRESH = 'FRESH-SECRET-77aa'
    await server.forPost('/login').thenJson(200, { token: FRESH })
    const me = await server.forGet('/me').thenReply(200, 'ok')
    const ws = workspaceWith({
      '01-login.http':
        script('post-response', 'fp.environment.set("token", fp.response.json().token)') +
        '\nPOST {{baseUrl}}/login\n',
      '02-me.http':
        script('pre-request', 'fp.log("using", fp.environment.get("token"))') +
        '\nGET {{baseUrl}}/me\nAuthorization: Bearer {{token}}\n'
    })
    const { key, fpk } = await withSecrets(ws)
    setEnvVariables(ws, { token: await secrets.encryptValue(key, 'token', 'stored') })
    const json = join(ws, 'report.json')

    const { out, err } = await run(
      ws,
      { reporters: [{ type: 'cli' }, { type: 'json', output: json }], showSecrets: true },
      { FETCHPIER_WORKSPACE_KEY: fpk }
    )

    expect((await me.getSeenRequests())[0].headers.authorization).toBe(`Bearer ${FRESH}`)
    // The login's own response body carries the token — response bodies are out
    // of scope (`--reporter-json-no-body`). Everything the *next* request shows
    // (its headers, its script output) is masked, even with --show-secrets.
    const meUnit = JSON.stringify(JSON.parse(readFileSync(json, 'utf-8')).units[1])
    for (const text of [out, err, meUnit]) expect(text).not.toContain(FRESH)
    expect(meUnit).toContain('{secret:token}')
  })

  // CLI-101
  it('--persist-env writes the local values like the desktop; without a key the secret is skipped with a warning', async () => {
    await server.forPost('/login').thenReply(200, 'ok')
    const files = {
      '01-login.http':
        script(
          'post-response',
          'fp.environment.set("token", "jwt")',
          'fp.environment.set("note", "n1")'
        ) + '\nPOST {{baseUrl}}/login\n'
    }

    const withKey = workspaceWith(files)
    const k1 = await withSecrets(withKey)
    setEnvVariables(withKey, { token: await secrets.encryptValue(k1.key, 'token', 'old') })
    await run(withKey, { persistEnv: true }, { FETCHPIER_WORKSPACE_KEY: k1.fpk })
    const persisted = await secrets.readLocalValues(withKey, '6f1c0b2e-1111-4000-8000-000000000001')
    expect(persisted.variables.note).toBe('n1')
    expect(await secrets.decryptValue(k1.key, 'token', persisted.variables.token)).toBe('jwt')

    const noKey = workspaceWith(files)
    const k2 = await withSecrets(noKey)
    setEnvVariables(noKey, { token: await secrets.encryptValue(k2.key, 'token', 'old') })
    const { summary, err } = await run(noKey, { persistEnv: true })
    expect(summary.summary.requests.failed).toBe(0)
    expect(err).toContain('secret variable "token" was set by a script but not saved')
    expect(err).toContain('FETCHPIER_WORKSPACE_KEY')
    const partial = await secrets.readLocalValues(noKey, '6f1c0b2e-1111-4000-8000-000000000001')
    expect(partial.variables).toEqual({ note: 'n1' })
  })

  // CLI-102
  it('--persist-env with local values under an older key: secrets skipped, plain persisted, entries intact', async () => {
    await server.forPost('/login').thenReply(200, 'ok')
    const me = await server.forGet('/me').thenReply(200, 'ok')
    const ws = workspaceWith({
      '01-login.http':
        script(
          'post-response',
          'fp.environment.set("token", "jwt-new")',
          'fp.environment.set("note", "n1")'
        ) + '\nPOST {{baseUrl}}/login\n',
      '02-me.http': 'GET {{baseUrl}}/me\nAuthorization: Bearer {{token}}\n'
    })
    const { key, fpk } = await withSecrets(ws)
    setEnvVariables(ws, { token: await secrets.encryptValue(key, 'token', 'shared') })
    const envId = '6f1c0b2e-1111-4000-8000-000000000001'
    const old = await secrets.generateWorkspaceKey()
    const oldEnc = await secrets.encryptValue(old, 'token', 'old-local')
    await secrets.writeLocalValues(ws, envId, {
      version: 1,
      keyId: secrets.deriveKeyId(old),
      variables: { token: oldEnc }
    })

    const { err } = await run(ws, { persistEnv: true }, { FETCHPIER_WORKSPACE_KEY: fpk })

    expect((await me.getSeenRequests())[0].headers.authorization).toBe('Bearer jwt-new')
    expect(err).toContain('encrypted with a previous workspace key')
    expect(err).toContain('Open the workspace in the desktop app with the new key')
    const after = await secrets.readLocalValues(ws, envId)
    expect(after.variables.token).toBe(oldEnc)
    expect(after.keyId).toBe(secrets.deriveKeyId(old))
    expect(after.variables.note).toBe('n1')
  })
})

describe('CLI readiness — secrets and credentials in output', () => {
  // CLI-103
  it('a secret in fp.log and in a failed assertion is masked in terminal, every report and history', async () => {
    const SECRET = 'S3CR3T-in-the-log'
    await server.forGet('/probe').thenReply(200, 'ok')
    const ws = workspaceWith({
      'probe.http':
        script(
          'post-response',
          'const t = fp.environment.get("apiToken")',
          'fp.log("token is", t)',
          'fp.test("token " + t, () => { fp.expect(t).to.equal("other") })'
        ) + '\nGET {{baseUrl}}/probe\nX-Token: {{apiToken}}\n'
    })
    const { key, fpk } = await withSecrets(ws)
    setEnvVariables(ws, { apiToken: await secrets.encryptValue(key, 'apiToken', SECRET) })
    const json = join(ws, 'r.json')
    const junit = join(ws, 'r.xml')
    const html = join(ws, 'r.html')

    const { out, err } = await run(
      ws,
      {
        reporters: [
          { type: 'cli' },
          { type: 'json', output: json },
          { type: 'junit', output: junit },
          { type: 'html', output: html }
        ],
        saveHistory: true
      },
      { FETCHPIER_WORKSPACE_KEY: fpk }
    )

    const runs = join(ws, 'requests', '.runs')
    const history = readdirSync(runs).map((f) => readFileSync(join(runs, f), 'utf-8'))
    for (const text of [
      out,
      err,
      readFileSync(json, 'utf-8'),
      readFileSync(junit, 'utf-8'),
      readFileSync(html, 'utf-8'),
      ...history
    ]) {
      expect(text).not.toContain(SECRET)
    }
    expect(out).toContain('{secret:apiToken}')
  })

  // CLI-104
  it('redacts the API-key credential and cookie values unless --show-secrets', async () => {
    await server
      .forGet('/keyed')
      .thenReply(200, 'ok', { 'set-cookie': 'session=sess-value-1; Path=/; HttpOnly' })
    const ws = workspaceWith({
      '01-query.http': [
        '# @auth',
        '# type: api-key',
        '# key: api_key',
        '# value: AK-QUERY-1',
        '# location: query',
        '# @end-auth',
        '',
        'GET {{baseUrl}}/keyed?api_key=AK-QUERY-1',
        'Cookie: pref=cookie-value-1',
        ''
      ].join('\n'),
      '02-header.http': [
        '# @auth',
        '# type: api-key',
        '# key: X-API-Key',
        '# value: AK-HEADER-1',
        '# location: header',
        '# @end-auth',
        '',
        'GET {{baseUrl}}/keyed',
        'X-API-Key: AK-HEADER-1',
        ''
      ].join('\n')
    })
    const json = join(ws, 'r.json')
    const secretsSeen = ['AK-QUERY-1', 'AK-HEADER-1', 'cookie-value-1', 'sess-value-1']

    const redacted = await run(ws, {
      reporters: [{ type: 'cli' }, { type: 'json', output: json }],
      verbosity: 2
    })
    const report = readFileSync(json, 'utf-8')
    for (const s of secretsSeen) {
      expect(redacted.out).not.toContain(s)
      expect(report).not.toContain(s)
    }
    expect(report).toContain('api_key=[REDACTED]')
    expect(report).toContain('pref=[REDACTED]')
    expect(report).toContain('session=[REDACTED]; Path=/; HttpOnly')

    await run(ws, {
      reporters: [{ type: 'cli' }, { type: 'json', output: json }],
      showSecrets: true
    })
    const revealed = readFileSync(json, 'utf-8')
    for (const s of secretsSeen) expect(revealed).toContain(s)
  })
})

describe('CLI readiness — proxy', () => {
  // CLI-105 — the local test server doubles as the proxy: a request for an
  // unresolvable host only succeeds if it went through it.
  it('routes through HTTP_PROXY, honours NO_PROXY and --no-proxy, and fails a dead proxy in-band', async () => {
    await server.forGet('http://api.ci-proxy.test/via-proxy').thenReply(200, 'proxied')
    const ws = workspaceWith({ 'p.http': 'GET http://api.ci-proxy.test/via-proxy\n' })
    const proxyUrl = server.url.replace('localhost', '127.0.0.1')

    const viaEnv = await run(ws, {}, { HTTP_PROXY: proxyUrl })
    expect(viaEnv.summary.summary.requests.passed).toBe(1)
    expect(viaEnv.out).toMatch(/Proxy: http:\/\/127\.0\.0\.1:\d+ \(from HTTP_PROXY\)/)

    const viaFlag = await run(ws, { proxy: proxyUrl.replace('http://', 'http://user:pw-secret@') })
    expect(viaFlag.summary.summary.requests.passed).toBe(1)
    expect(viaFlag.out).toContain('(from --proxy)')
    expect(viaFlag.out + viaFlag.err).not.toContain('pw-secret')

    const excluded = await run(ws, {}, { HTTP_PROXY: proxyUrl, NO_PROXY: '.ci-proxy.test' })
    expect(excluded.summary.summary.requests.failed).toBe(1)
    const ignored = await run(ws, { noProxy: true }, { HTTP_PROXY: proxyUrl })
    expect(ignored.summary.summary.requests.failed).toBe(1)

    const dead = await run(ws, { proxy: 'http://127.0.0.1:1' })
    expect(dead.summary.summary.requests.failed).toBe(1)
    expect(dead.out).toContain('no response:')
  })
})

describe('CLI readiness — signals and output', () => {
  // CLI-106
  it('an expired timeout fails the request stating the limit', async () => {
    await server.forGet('/hang').thenTimeout()
    const ws = workspaceWith({ 'hang.http': 'GET {{baseUrl}}/hang\n' })
    const { summary, out } = await run(ws, { timeoutMs: 200 })
    expect(summary.units[0].error).toBe('timed out after 200 ms')
    expect(out).toContain('no response: timed out after 200 ms')
  })

  // CLI-106 (programmatic API): the same validation as the binary.
  it.each([
    [{ timeoutMs: -1 }, 'timeoutMs'],
    [{ timeoutMs: 1.5 }, 'timeoutMs'],
    [{ delay: Number.NaN }, 'delay'],
    [{ proxy: 'http://p:1', noProxy: true }, 'noProxy']
  ] as const)('run() refuses %j as a usage error', async (bad, name) => {
    const ws = workspaceWith({ 'x.http': 'GET {{baseUrl}}/x\n' })
    await expect(run(ws, bad)).rejects.toMatchObject({
      exitCode: 3,
      message: expect.stringContaining(name)
    })
  })

  // CLI-107
  it('multi-file runs show script output by default and add detail per -v level', async () => {
    await server.forGet('/one').thenReply(200, 'body-one', { 'x-trace': 't1' })
    await server.forGet('/two').thenReply(200, 'body-two')
    const ws = workspaceWith({
      '1.http': script('post-response', 'fp.log("log from one")') + '\nGET {{baseUrl}}/one\n',
      '2.http': script('post-response', 'fp.log("log from two")') + '\nGET {{baseUrl}}/two\n'
    })
    const quiet = await run(ws)
    expect(quiet.out).toContain('[log] log from one')
    expect(quiet.out).toContain('[log] log from two')
    expect(quiet.out).not.toContain('x-trace')

    const verbose = await run(ws, { verbosity: 3 })
    expect(verbose.out).toContain('x-trace: t1')
    expect(verbose.out).toContain('body-one')
  })

  // CLI-108
  it('shows the environment by folder name, and the JSON report carries it additively', async () => {
    await server.forGet('/env').thenReply(200, 'ok')
    const ws = workspaceWith({ 'e.http': 'GET {{baseUrl}}/env\n' }, {}, 'staging')
    const json = join(ws, 'r.json')
    const { out } = await run(ws, {
      environment: 'staging',
      reporters: [{ type: 'cli' }, { type: 'json', output: json }]
    })
    expect(out).toContain('Environment: staging\n')
    expect(out).not.toContain('6f1c0b2e')
    const report = JSON.parse(readFileSync(json, 'utf-8'))
    expect(report.schemaVersion).toBe('1.0')
    expect(report.environment).toBe('6f1c0b2e-1111-4000-8000-000000000001')
    expect(report.environmentName).toBe('staging')
  })

  // CLI-109
  it('labels attempted sends "no response" and never-attempted ones "not run" in terminal, HTML and JUnit', async () => {
    const ws = workspaceWith({
      'a-empty.http': '# only a comment\n',
      'b-aborted.http': script('pre-request', 'throw new Error("stop")') + '\nGET {{baseUrl}}/x\n',
      'c-down.http': 'GET http://127.0.0.1:1/down\n'
    })
    const junit = join(ws, 'r.xml')
    const html = join(ws, 'r.html')
    const { out } = await run(ws, {
      reporters: [{ type: 'cli' }, { type: 'junit', output: junit }, { type: 'html', output: html }]
    })
    const xml = readFileSync(junit, 'utf-8')
    const page = readFileSync(html, 'utf-8')
    expect(out).toContain('not run: no request found in this file')
    expect(out).toMatch(/not run: Pre-request script failed/)
    expect(out).toContain('no response:')
    expect(xml.match(/<testcase name="not run"/g)).toHaveLength(2)
    expect(xml.match(/<testcase name="no response"/g)).toHaveLength(1)
    expect(page).toContain('not run')
    for (const text of [out, xml, page]) expect(text).not.toContain('request not sent')
  })

  // CLI-110
  it('engine and parser diagnostics are warnings, never raw console lines', async () => {
    const consoleWarn = vi.spyOn(console, 'warn')
    const consoleError = vi.spyOn(console, 'error')
    await server.forGet('/diag').thenReply(200, 'ok')
    const ws = workspaceWith({
      'a.http': 'GET {{baseUrl}}/diag\nX-Missing: {{missing}}\n',
      'b.http': '# @auth\n# type: oauth9\n# @end-auth\n\nGET {{baseUrl}}/diag\n'
    })
    const { err } = await run(ws)
    expect(consoleWarn).not.toHaveBeenCalled()
    expect(consoleError).not.toHaveBeenCalled()
    expect(err).toContain('Warning: requests/a.http: variable "missing" has no value')
    expect(err).toContain('Warning: requests/b.http: invalid # @auth block')
    expect(err).not.toContain('[execute]')
    expect(err).not.toContain('[parser]')
  })

  // CLI-111
  it('sends the CLI User-Agent and Accept-Encoding, and decodes gzip with both sizes in the report', async () => {
    const payload = JSON.stringify({ items: 'x'.repeat(4000) })
    const gz = await server
      .forGet('/gz')
      .thenReply(200, gzipSync(Buffer.from(payload)), { 'content-encoding': 'gzip' })
    const ws = workspaceWith({
      'gz.http':
        script(
          'post-response',
          'fp.test("parsed", () => fp.expect(fp.response.json().items.length).to.equal(4000))'
        ) + '\nGET {{baseUrl}}/gz\n'
    })
    const json = join(ws, 'r.json')
    const { summary } = await run(ws, {
      reporters: [{ type: 'cli' }, { type: 'json', output: json }]
    })
    const [seen] = await gz.getSeenRequests()
    expect(seen.headers['user-agent']).toBe(`Fetchpier-CLI/${CLI_VERSION}`)
    expect(seen.headers['accept-encoding']).toBe('gzip, deflate, br')
    expect(summary.summary.tests.passed).toBe(1)
    const response = JSON.parse(readFileSync(json, 'utf-8')).units[0].response
    expect(response.decodingStatus).toBe('decoded')
    expect(response.compressedBytes).toBeLessThan(response.decompressedBytes)
    expect(response.sizeBytes).toBe(response.decompressedBytes)
  })

  // CLI-112
  it('an undecodable body keeps the status, warns, and json() fails with the real cause', async () => {
    await server.forGet('/zstd').thenReply(200, 'opaque-bytes', { 'content-encoding': 'zstd' })
    const ws = workspaceWith({
      'z.http':
        script('post-response', 'fp.test("json", () => fp.response.json())') +
        '\nGET {{baseUrl}}/zstd\n'
    })
    const { summary, err } = await run(ws)
    expect(summary.units[0].response?.status).toBe(200)
    expect(summary.units[0].response?.decodingStatus).toBe('unsupported')
    expect(err).toContain('unsupported content encoding (zstd)')
    expect(summary.units[0].tests[0].error).toMatch(/could not be decoded \(zstd/)
  })
})
