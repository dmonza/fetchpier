import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import http from 'node:http'
import http2 from 'node:http2'
import type { AddressInfo } from 'node:net'
import { generateCACertificate, getLocal, type Mockttp } from 'mockttp'
import { sendRequestWithRaw } from './client'
import { resolveRequestTls } from '../tls/resolve'
import { DEFAULT_WORKSPACE_HTTP_SETTINGS } from '../workspace/defaults'
import type { ProxyConfig, WorkspaceHttpSettings } from '@shared/types'

/**
 * The transport against real local servers (PIPE-008..012).
 *
 * Every case here rests on what undici itself does on the wire: how it frames a
 * streamed body, when its redirect handler gives up on a consumed one, how its
 * proxy agent rebuilds the request headers, and what it raises when a proxy
 * refuses a tunnel. The mocked client tests assert our belief about those
 * shapes; these assert the shapes.
 */

interface Seen {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  rawHeaders: string[]
  body: string
}

type Route = (req: http.IncomingMessage, res: http.ServerResponse) => void

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
  })
}

/** A plain HTTP server recording every request and answering from `routes`. */
async function startRecorder(): Promise<{
  server: http.Server
  origin: string
  seen: Seen[]
  routes: Map<string, Route>
}> {
  const seen: Seen[] = []
  const routes = new Map<string, Route>()
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req)
    seen.push({
      method: req.method ?? '',
      url: req.url ?? '',
      headers: req.headers,
      rawHeaders: req.rawHeaders,
      body
    })
    const path = new URL(req.url ?? '/', 'http://unused').pathname
    const route = routes.get(path)
    if (route) route(req, res)
    else {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { server, origin: `http://127.0.0.1:${port}`, seen, routes }
}

async function stop(server: http.Server | http2.Http2SecureServer): Promise<void> {
  if ('closeAllConnections' in server) server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

const settings = (overrides: Partial<WorkspaceHttpSettings> = {}): WorkspaceHttpSettings => ({
  ...DEFAULT_WORKSPACE_HTTP_SETTINGS,
  ...overrides
})

const proxyAt = (url: string): ProxyConfig => ({ enabled: true, url, username: '', password: '' })

let target: Awaited<ReturnType<typeof startRecorder>>

beforeAll(async () => {
  target = await startRecorder()
})

afterAll(async () => {
  await stop(target.server)
})

afterEach(() => {
  target.seen.length = 0
  target.routes.clear()
})

const BODY = '{"id":1}'

// ── ENG-04: framing and redirects of a body on a non-payload method ─────────

describe('PIPE-008 / PIPE-009 — a body on a non-payload method (ENG-04)', () => {
  it.each(['GET', 'DELETE', 'OPTIONS'])(
    'arrives on %s with Content-Length, not chunked',
    async (method) => {
      await sendRequestWithRaw(
        { method, url: `${target.origin}/items/`, headers: {}, body: BODY },
        { settings: settings() }
      )
      expect(target.seen).toHaveLength(1)
      expect(target.seen[0].headers['content-length']).toBe('8')
      expect(target.seen[0].headers['transfer-encoding']).toBeUndefined()
      expect(target.seen[0].body).toBe(BODY)
    }
  )

  it.each([301, 302, 307, 308])('follows a %d with the body on the next hop', async (status) => {
    target.routes.set('/items', (_req, res) => {
      res.writeHead(status, { location: '/items/' })
      res.end()
    })
    const { response } = await sendRequestWithRaw(
      { method: 'DELETE', url: `${target.origin}/items`, headers: {}, body: BODY },
      { settings: settings() }
    )
    expect(response.status).toBe(200)
    expect(target.seen.map((s) => [s.method, s.url, s.body])).toEqual([
      ['DELETE', '/items', BODY],
      ['DELETE', '/items/', BODY]
    ])
    expect(target.seen[1].headers['content-length']).toBe('8')
  })

  it('follows a 303 as a GET without the body', async () => {
    target.routes.set('/items', (_req, res) => {
      res.writeHead(303, { location: '/done' })
      res.end()
    })
    const { response } = await sendRequestWithRaw(
      { method: 'DELETE', url: `${target.origin}/items`, headers: {}, body: BODY },
      { settings: settings() }
    )
    expect(response.status).toBe(200)
    expect(target.seen.map((s) => [s.method, s.url, s.body])).toEqual([
      ['DELETE', '/items', BODY],
      ['GET', '/done', '']
    ])
    expect(target.seen[1].headers['content-length']).toBeUndefined()
  })

  it('still follows a 307 on POST with the body (control)', async () => {
    target.routes.set('/items', (_req, res) => {
      res.writeHead(307, { location: '/items/' })
      res.end()
    })
    const { response } = await sendRequestWithRaw(
      { method: 'POST', url: `${target.origin}/items`, headers: {}, body: BODY },
      { settings: settings() }
    )
    expect(response.status).toBe(200)
    expect(target.seen.map((s) => [s.method, s.body])).toEqual([
      ['POST', BODY],
      ['POST', BODY]
    ])
    expect(target.seen[1].headers['content-length']).toBe('8')
  })

  it('returns the redirect itself when redirects are off', async () => {
    target.routes.set('/items', (_req, res) => {
      res.writeHead(307, { location: '/items/' })
      res.end()
    })
    const { response } = await sendRequestWithRaw(
      { method: 'DELETE', url: `${target.origin}/items`, headers: {}, body: BODY },
      { settings: settings({ followRedirects: false }) }
    )
    expect(response.status).toBe(307)
    expect(target.seen.map((s) => s.body)).toEqual([BODY])
  })

  it('sends a body on a non-payload method over HTTP/2 without tripping the transport', async () => {
    const identity = await generateCACertificate({ subject: { commonName: 'localhost' } })
    const received: Array<{ version: string; length?: string; body: string }> = []
    const server = http2.createSecureServer(identity, async (req, res) => {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      received.push({
        version: req.httpVersion,
        length: req.headers['content-length'],
        body: Buffer.concat(chunks).toString('utf-8')
      })
      res.writeHead(200)
      res.end('ok')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = server.address() as AddressInfo
      const { response } = await sendRequestWithRaw(
        { method: 'DELETE', url: `https://localhost:${port}/items`, headers: {}, body: BODY },
        { settings: settings({ httpVersion: 'http2', verifySsl: false }) }
      )
      expect(response.status).toBe(200)
      expect(received).toEqual([{ version: '2.0', length: '8', body: BODY }])
    } finally {
      await stop(server)
    }
  })
})

// ── ENG-07: repeated request headers through a proxy ────────────────────────

describe('PIPE-010 — repeated request headers through a proxy (ENG-07)', () => {
  it('reach the wire with every value, as on a direct send', async () => {
    const headerList = [
      { name: 'X-Tag', value: 'one' },
      { name: 'Accept', value: 'application/json' },
      { name: 'X-Tag', value: 'two' },
      { name: 'Accept', value: 'text/plain' }
    ]
    const request = {
      method: 'GET',
      url: 'http://origin.invalid/x',
      headers: { 'X-Tag': 'two', Accept: 'text/plain' },
      headerList
    }
    // A plain-http target reaches an HTTP proxy in absolute form, so the
    // recorder acting as the proxy sees exactly the headers it was handed.
    const { response } = await sendRequestWithRaw(request, {
      settings: settings(),
      proxy: proxyAt(target.origin)
    })
    expect(response.status).toBe(200)
    expect(target.seen[0].url).toBe('http://origin.invalid/x')

    const pairs = (raw: string[]): string[] =>
      raw.flatMap((v, i) =>
        i % 2 === 0 && /^(x-tag|accept)$/i.test(v) ? [`${v}: ${raw[i + 1]}`] : []
      )
    const proxied = pairs(target.seen[0].rawHeaders)
    expect(proxied.filter((p) => p.startsWith('X-Tag'))).toEqual(['X-Tag: one', 'X-Tag: two'])
    expect(proxied.filter((p) => p.startsWith('Accept'))).toEqual([
      'Accept: application/json',
      'Accept: text/plain'
    ])
  })
})

// ── ENG-01: a proxy that refuses the tunnel ─────────────────────────────────

describe('PIPE-011 — a proxy that refuses the CONNECT tunnel (ENG-01)', () => {
  it('fails naming the proxy refusal, not as a cancellation', async () => {
    const proxy = http.createServer()
    proxy.on('connect', (_req, socket) => {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n')
    })
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = proxy.address() as AddressInfo
      await expect(
        sendRequestWithRaw(
          { method: 'GET', url: 'https://api.invalid/x', headers: {} },
          { settings: settings(), proxy: proxyAt(`http://127.0.0.1:${port}`) }
        )
      ).rejects.toThrow('Proxy refused the tunnel (407 Proxy Authentication Required)')
    } finally {
      await stop(proxy)
    }
  })
})

// ── ENG-08: an HTTPS proxy signed by a custom CA ────────────────────────────

describe('PIPE-012 — an HTTPS proxy signed by a custom CA (ENG-08)', () => {
  let proxy: Mockttp
  let certsDir = ''

  beforeAll(async () => {
    const ca = await generateCACertificate()
    proxy = getLocal({ https: ca })
    await proxy.start()
    await proxy.forAnyRequest().thenReply(200, 'via-proxy')
    certsDir = await fs.mkdtemp(join(tmpdir(), 'client-wire-ca-'))
    await fs.writeFile(join(certsDir, 'corp.pem'), ca.cert)
  }, 60_000)

  afterAll(async () => {
    await proxy.stop()
    await fs.rm(certsDir, { recursive: true, force: true })
  })

  const tls = (url: string) =>
    resolveRequestTls(
      url,
      {},
      {
        workspacePath: null,
        run: {
          certsDir,
          settings: { caCertificates: [{ id: 'corp', file: 'corp.pem' }], clientCertificates: [] }
        }
      }
    )

  it('is trusted for an http:// target, with verification on', async () => {
    const { response } = await sendRequestWithRaw(
      { method: 'GET', url: 'http://intranet.invalid/x', headers: {} },
      {
        settings: settings({ verifySsl: true }),
        proxy: proxyAt(`https://localhost:${proxy.port}`),
        tls
      }
    )
    expect(response.status).toBe(200)
    expect(response.body).toBe('via-proxy')
  })
})
