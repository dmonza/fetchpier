import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { getLocal, type Mockttp } from 'mockttp'
import { execute } from './execute'
import { DEFAULT_WORKSPACE_HTTP_SETTINGS } from '../workspace/defaults'
import { createSecretMasker, mintExecutionNonce } from '../secrets/markers'
import type { HttpRequest } from '@shared/types'

// CLI readiness for CI — engine-level behavior shared by both adapters:
// implicit default headers, script-output masking, decoding, advisories in place
// of console lines.

let server: Mockttp
beforeAll(async () => {
  server = getLocal()
  await server.start()
})
afterAll(async () => {
  await server.stop()
})

const base = { environmentId: null, workspaceSettings: DEFAULT_WORKSPACE_HTTP_SETTINGS }

describe('execute() — implicit default headers', () => {
  it('adds the surface User-Agent and Accept-Encoding when absent, and reports them in the snapshot', async () => {
    const endpoint = await server.forGet('/defaults').thenReply(200, 'ok')
    const result = await execute(
      { method: 'GET', url: `${server.url}/defaults`, headers: {} },
      { ...base, userAgent: 'Fetchpier-CLI/1.2.3' }
    )
    const [seen] = await endpoint.getSeenRequests()
    expect(seen.headers['user-agent']).toBe('Fetchpier-CLI/1.2.3')
    expect(seen.headers['accept-encoding']).toBe('gzip, deflate, br')
    expect(result.request?.headers['User-Agent']).toBe('Fetchpier-CLI/1.2.3')
    expect(result.request?.headers['Accept-Encoding']).toBe('gzip, deflate, br')
  })

  it('sends a user-written value as written, whatever its casing', async () => {
    const endpoint = await server.forGet('/user-values').thenReply(200, 'ok')
    await execute(
      {
        method: 'GET',
        url: `${server.url}/user-values`,
        headers: { 'user-agent': 'Fetchpier/0.1.0', 'ACCEPT-ENCODING': 'identity' },
        headerList: [
          { name: 'user-agent', value: 'Fetchpier/0.1.0' },
          { name: 'ACCEPT-ENCODING', value: 'identity' }
        ]
      },
      { ...base, userAgent: 'Fetchpier/9.9.9' }
    )
    const [seen] = await endpoint.getSeenRequests()
    expect(seen.headers['user-agent']).toBe('Fetchpier/0.1.0')
    expect(seen.headers['accept-encoding']).toBe('identity')
  })
})

describe('execute() — response decoding', () => {
  it('decodes a gzip response for the post-response script and the result', async () => {
    const json = JSON.stringify({ token: 'abc', pad: 'x'.repeat(500) })
    await server
      .forGet('/gz')
      .thenReply(200, gzipSync(Buffer.from(json)), { 'content-encoding': 'gzip' })
    const result = await execute(
      {
        method: 'GET',
        url: `${server.url}/gz`,
        headers: {},
        postResponseScript:
          'fp.test("decoded", () => { fp.expect(fp.response.json().token).to.equal("abc"); fp.expect(fp.response.decodingStatus).to.equal("decoded") })'
      },
      base
    )
    expect(result.response?.body).toBe(json)
    expect(result.response?.decodingStatus).toBe('decoded')
    expect(result.response!.compressedBytes!).toBeLessThan(result.response!.decompressedBytes!)
    expect(result.scriptResults?.postResponse?.testResults[0].passed).toBe(true)
  })

  it('an unsupported coding is advised, not failed, and json() names the real cause', async () => {
    await server.forGet('/zstd').thenReply(200, 'opaque', { 'content-encoding': 'zstd' })
    const result = await execute(
      {
        method: 'GET',
        url: `${server.url}/zstd`,
        headers: {},
        postResponseScript: 'fp.response.json()'
      },
      base
    )
    expect(result.response?.status).toBe(200)
    expect(result.error).toBeUndefined()
    expect(result.warnings).toContainEqual({
      code: 'UNSUPPORTED_CONTENT_ENCODING',
      encoding: 'zstd'
    })
    expect(result.scriptResults?.postResponse?.error?.message).toMatch(/could not be decoded/)
  })
})

describe('execute() — secret masking of script output', () => {
  const SECRET = 'SEKRET-zz-998877'

  it('masks a referenced secret in fp.log, test names and assertion messages', async () => {
    await server.forGet('/masked').thenReply(200, 'ok')
    const masker = createSecretMasker({
      nonce: mintExecutionNonce(),
      plaintextByName: { apiToken: SECRET }
    })
    const req: HttpRequest = {
      method: 'GET',
      url: `${server.url}/masked`,
      headers: { 'X-Token': '{{apiToken}}' },
      variables: { ...masker.markerVariables },
      postResponseScript: [
        'const t = fp.environment.get("apiToken")',
        'fp.log("token:", t, { nested: t })',
        'fp.test("compare " + t, () => { fp.expect(t).to.equal("other") })'
      ].join('\n')
    }
    const result = await execute(req, { ...base, secrets: masker })
    const text = JSON.stringify(result.scriptResults)
    expect(text).not.toContain(SECRET)
    expect(text).toContain('{secret:apiToken}')
  })

  it('masks a value a script writes under a secret name in the same send', async () => {
    await server.forGet('/write-secret').thenReply(200, 'ok')
    const result = await execute(
      {
        method: 'GET',
        url: `${server.url}/write-secret`,
        headers: {},
        postResponseScript: `fp.environment.set("token", "${SECRET}"); fp.log("${SECRET}")`
      },
      { ...base, secretNames: ['token'] }
    )
    expect(JSON.stringify(result.scriptResults)).not.toContain(SECRET)
    // The top-level changes keep the plaintext: the session needs it to apply them.
    expect(result.environmentChanges?.set.token).toBe(SECRET)
  })

  it('a plain value written by a script is left as is', async () => {
    await server.forGet('/write-plain').thenReply(200, 'ok')
    const result = await execute(
      {
        method: 'GET',
        url: `${server.url}/write-plain`,
        headers: {},
        postResponseScript: 'fp.environment.set("id", "42"); fp.log("id 42")'
      },
      { ...base, secretNames: ['token'] }
    )
    expect(result.scriptResults?.postResponse?.logs[0].args).toEqual(['id 42'])
  })
})

describe('the send path never writes to the process console', () => {
  // A console line is a channel neither the desktop nor a CI report can read; on
  // the command line it surfaced as raw `[execute]` / `[parser]` lines. Every
  // module on the send path reports through advisories instead.
  it.each([
    'requests/execute.ts',
    'requests/client.ts',
    'requests/parser.ts',
    'requests/decode-body.ts',
    'requests/proxy-env.ts',
    'requests/variable-session.ts',
    'tls/resolve.ts',
    'tls/matcher.ts',
    'scripting/mask-script-results.ts'
  ])('%s has no console call', async (rel) => {
    const source = await fs.readFile(join(__dirname, '..', rel), 'utf-8')
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
    expect(code).not.toMatch(/\bconsole\.(log|warn|error|info|debug)\s*\(/)
  })
})

describe('execute() — advisories instead of console lines', () => {
  const dirs: string[] = []
  afterEach(async () => {
    for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('an unresolved variable is only an advisory', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await server.forGet('/unresolved').thenReply(200, 'ok')
    const result = await execute(
      { method: 'GET', url: `${server.url}/unresolved`, headers: { 'X-A': '{{missing}}' } },
      base
    )
    expect(result.warnings).toContainEqual({ code: 'UNRESOLVED_VARIABLE', name: 'missing' })
    expect(warn).not.toHaveBeenCalled()
  })

  it('a cookie jar that cannot be written is advised and the response is unaffected', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ws = await fs.mkdtemp(join(tmpdir(), 'jar-broken-'))
    dirs.push(ws)
    const envDir = join(ws, 'environments', 'dev')
    // A directory where the jar file belongs: the captured cookie cannot be stored.
    await fs.mkdir(join(envDir, '.state', 'cookies.json'), { recursive: true })
    await fs.writeFile(
      join(envDir, 'config.json'),
      JSON.stringify({ id: 'dev', name: 'dev', variables: {} })
    )
    await server.forGet('/jar').thenReply(200, 'ok', { 'set-cookie': 'session=abc; Path=/' })
    const result = await execute(
      { method: 'GET', url: `${server.url}/jar`, headers: {} },
      { ...base, environmentId: 'dev', workspacePath: ws }
    )
    expect(result.response?.status).toBe(200)
    expect(result.warnings?.some((w) => w.code === 'COOKIE_JAR_UNAVAILABLE')).toBe(true)
    expect(error).not.toHaveBeenCalled()
  })

  it('a failing TLS resolver is advised and the send proceeds', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await server.forGet('/tls').thenReply(200, 'ok')
    const result = await execute(
      { method: 'GET', url: `${server.url}/tls`, headers: {} },
      {
        ...base,
        resolveTls: async (_url, _env, onWarning) => {
          onWarning?.('the client certificate could not be read')
          throw new Error('boom')
        }
      }
    )
    expect(result.response?.status).toBe(200)
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        { code: 'TLS_MATERIAL_UNAVAILABLE', reason: 'the client certificate could not be read' },
        { code: 'TLS_MATERIAL_UNAVAILABLE', reason: 'boom' }
      ])
    )
    expect(error).not.toHaveBeenCalled()
  })

  it('a send that fails in transport keeps the pre-request script output and its writes', async () => {
    const result = await execute(
      {
        method: 'GET',
        url: 'http://127.0.0.1:1/unreachable',
        headers: {},
        preRequestScript: 'fp.environment.set("step", "pre"); fp.log("before send")'
      },
      base
    )
    expect(result.response).toBeUndefined()
    expect(result.error).toBeTruthy()
    // A send was attempted: not a "not run".
    expect(result.notSent).toBeUndefined()
    expect(result.environmentChanges?.set.step).toBe('pre')
    expect(result.scriptResults?.preRequest?.logs[0].args).toEqual(['before send'])
  })

  it('a failed pre-request script is a refusal to send (notSent)', async () => {
    const result = await execute(
      {
        method: 'GET',
        url: 'http://127.0.0.1:1/never',
        headers: {},
        preRequestScript: 'throw new Error("stop")'
      },
      base
    )
    expect(result.notSent).toBe(true)
  })
})

// ── Binary bodies are the engine's (CLI hardening) ────────────────────────────

describe('execute() — binary bodies read from the workspace', () => {
  const REF = `${'a'.repeat(64)}__payload.bin`
  const BYTES = Buffer.from([0, 1, 2, 3, 254, 255, 10, 13, 9]) // 9 bytes, not UTF-8 text
  let ws = ''

  beforeAll(async () => {
    ws = await fs.mkdtemp(join(tmpdir(), 'binary-exec-'))
    await fs.mkdir(join(ws, 'requests', '.files'), { recursive: true })
    await fs.writeFile(join(ws, 'requests', '.files', REF), BYTES)
  })
  afterAll(async () => {
    await fs.rm(ws, { recursive: true, force: true })
  })

  const binaryRequest = (url: string, over: Partial<HttpRequest> = {}): HttpRequest => ({
    method: 'POST',
    url,
    headers: {},
    bodyType: 'binary',
    binaryFile: {
      ref: REF,
      originalName: 'payload.bin',
      sizeBytes: 0,
      mimeType: 'application/octet-stream'
    },
    ...over
  })

  it('sends exactly the file bytes with the Content-Type of its type', async () => {
    const endpoint = await server.forPost('/bin').thenReply(200, 'ok')
    const result = await execute(binaryRequest(`${server.url}/bin`), {
      ...base,
      workspacePath: ws
    })
    expect(result.response?.status).toBe(200)
    const [seen] = await endpoint.getSeenRequests()
    expect(Buffer.from((await seen.body.getDecodedBuffer()) as Buffer)).toEqual(BYTES)
    expect(seen.headers['content-type']).toBe('application/octet-stream')
    expect(result.request?.headers['Content-Type']).toBe('application/octet-stream')
  })

  it('keeps a Content-Type the user set', async () => {
    const endpoint = await server.forPost('/bin-ct').thenReply(200, 'ok')
    await execute(
      binaryRequest(`${server.url}/bin-ct`, { headers: { 'Content-Type': 'image/x-custom' } }),
      { ...base, workspacePath: ws }
    )
    const [seen] = await endpoint.getSeenRequests()
    expect(seen.headers['content-type']).toBe('image/x-custom')
  })

  it('a missing file is refused before anything goes out', async () => {
    const endpoint = await server.forPost('/bin-missing').thenReply(200, 'ok')
    const result = await execute(
      binaryRequest(`${server.url}/bin-missing`, {
        binaryFile: {
          ref: `${'b'.repeat(64)}__gone.bin`,
          originalName: 'gone.bin',
          sizeBytes: 0,
          mimeType: 'application/octet-stream'
        }
      }),
      { ...base, workspacePath: ws }
    )
    expect(result.response).toBeUndefined()
    expect(result.notSent).toBe(true)
    expect(result.error).toBe('binary file not found: gone.bin')
    expect(await endpoint.getSeenRequests()).toHaveLength(0)
  })

  it('an invalid reference is refused, never sent bodiless', async () => {
    const endpoint = await server.forPost('/bin-invalid').thenReply(200, 'ok')
    const result = await execute(
      {
        method: 'POST',
        url: `${server.url}/bin-invalid`,
        headers: {},
        invalidBinaryRef: 'not-a-ref'
      },
      { ...base, workspacePath: ws }
    )
    expect(result.notSent).toBe(true)
    expect(result.error).toBe('invalid binary file reference: not-a-ref')
    expect(await endpoint.getSeenRequests()).toHaveLength(0)
  })

  it('bytes supplied by the adapter still win', async () => {
    const endpoint = await server.forPost('/bin-supplied').thenReply(200, 'ok')
    await execute(binaryRequest(`${server.url}/bin-supplied`), {
      ...base,
      workspacePath: ws,
      binaryBody: Buffer.from('xyz')
    })
    const [seen] = await endpoint.getSeenRequests()
    expect(await seen.body.getText()).toBe('xyz')
  })
})
