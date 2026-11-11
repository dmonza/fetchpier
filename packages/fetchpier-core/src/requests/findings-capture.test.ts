import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import http2 from 'node:http2'
import https from 'node:https'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { generateCACertificate } from 'mockttp'
import { sendRequestWithRaw } from './client'
import { execute, type ExecuteOptions } from './execute'
import { DEFAULT_WORKSPACE_HTTP_SETTINGS } from '../workspace/defaults'
import type { Finding, FindingsEvaluation, ProxyConfig, WorkspaceHttpSettings } from '@shared/types'

/**
 * Passive security findings — what a send observes about its own connections
 * (FIND-001, FIND-002, FIND-004 and the per-hop facts behind FIND-005/006).
 *
 * Real servers and the real transport: the whole point is that the facts come
 * from the connection the send itself opened, with no handshake added, and a
 * mocked transport could only restate that belief.
 */

type Identity = { key: string; cert: string }
type Route = (req: http.IncomingMessage, res: http.ServerResponse) => void

interface Server {
  origin: string
  /** TLS handshakes the server completed. */
  handshakes: number
  /** HTTP version of every request it answered. */
  versions: string[]
  routes: Map<string, Route>
  close: () => Promise<void>
}

const settings = (over: Partial<WorkspaceHttpSettings> = {}): WorkspaceHttpSettings => ({
  ...DEFAULT_WORKSPACE_HTTP_SETTINGS,
  verifySsl: false,
  ...over
})

function track(server: net.Server, routes: Map<string, Route>, versions: string[]): Server {
  const s: Server = { origin: '', handshakes: 0, versions, routes, close: async () => {} }
  server.on('secureConnection', () => {
    s.handshakes += 1
  })
  return s
}

function handler(routes: Map<string, Route>, versions: string[]) {
  return (req: http.IncomingMessage, res: http.ServerResponse): void => {
    versions.push(req.httpVersion)
    const route = routes.get(req.url ?? '')
    if (route) route(req, res)
    else {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    }
  }
}

/**
 * HTTPS servers listen on every interface and are addressed as `localhost`, the
 * name their certificate carries: the runtime reports a name mismatch as
 * "not authorized" even when verification is off, which would blur the trusted /
 * untrusted distinction the cases below rely on.
 */
async function listen(server: net.Server, s: Server, scheme = 'https'): Promise<Server> {
  const host = scheme === 'https' ? 'localhost' : '127.0.0.1'
  await new Promise<void>((resolve) =>
    scheme === 'https' ? server.listen(0, resolve) : server.listen(0, '127.0.0.1', resolve)
  )
  s.origin = `${scheme}://${host}:${(server.address() as AddressInfo).port}`
  s.close = () =>
    new Promise<void>((resolve) => {
      ;(server as http.Server).closeAllConnections?.()
      server.close(() => resolve())
    })
  return s
}

async function startHttps(identity: Identity): Promise<Server> {
  const routes = new Map<string, Route>()
  const versions: string[] = []
  const server = https.createServer(identity, handler(routes, versions))
  return listen(server, track(server, routes, versions))
}

async function startHttp2(identity: Identity): Promise<Server> {
  const routes = new Map<string, Route>()
  const versions: string[] = []
  const server = http2.createSecureServer(
    { ...identity, allowHTTP1: true },
    handler(routes, versions) as unknown as (
      req: http2.Http2ServerRequest,
      res: http2.Http2ServerResponse
    ) => void
  )
  const s = track(server, routes, versions)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  s.origin = `https://localhost:${(server.address() as AddressInfo).port}`
  const sessions = new Set<http2.ServerHttp2Session>()
  server.on('session', (session) => sessions.add(session))
  s.close = () =>
    new Promise<void>((resolve) => {
      for (const session of sessions) session.destroy()
      server.close(() => resolve())
    })
  return s
}

/** A CONNECT-tunnelling forward proxy, the shape an HTTPS target needs. */
interface TunnelProxy {
  config: ProxyConfig
  tunnels: number
  close: () => Promise<void>
}

async function startTunnelProxy(): Promise<TunnelProxy> {
  const sockets = new Set<Duplex>()
  const server = http.createServer((_req, res) => {
    res.writeHead(405)
    res.end()
  })
  const p: TunnelProxy = {
    config: { enabled: true, url: '', username: '', password: '' } as ProxyConfig,
    tunnels: 0,
    close: async () => {}
  }
  server.on('connect', (req, client, head) => {
    p.tunnels += 1
    const [host, port] = (req.url ?? '').split(':')
    const upstream = net.connect(Number(port), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
    })
    for (const s of [client, upstream]) {
      sockets.add(s)
      s.on('error', () => {})
      s.on('close', () => sockets.delete(s))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  p.config = {
    ...p.config,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }
  p.close = () =>
    new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy()
      server.close(() => resolve())
    })
  return p
}

let trusted: Identity
let untrusted: Identity
/** Serves `trusted`, the certificate the sends below accept as a CA. */
let a: Server
/** Serves `untrusted`. */
let b: Server
let h2: Server
let proxy: TunnelProxy

beforeAll(async () => {
  ;[trusted, untrusted] = await Promise.all([
    generateCACertificate({ subject: { commonName: 'localhost' } }),
    generateCACertificate({ subject: { commonName: 'localhost' } })
  ])
  ;[a, b, h2, proxy] = await Promise.all([
    startHttps(trusted),
    startHttps(untrusted),
    startHttp2(trusted),
    startTunnelProxy()
  ])
}, 60_000)

afterAll(async () => {
  await Promise.all([a.close(), b.close(), h2.close(), proxy.close()])
})

afterEach(() => {
  for (const s of [a, b, h2]) {
    s.handshakes = 0
    s.versions.length = 0
    s.routes.clear()
  }
  proxy.tunnels = 0
})

const trust = (): { ca: Buffer[] } => ({ ca: [Buffer.from(trusted.cert)] })

describe('FIND-001 — one connection per send, observed rather than repeated', () => {
  it('captures the TLS facts of an HTTP/1.1 send with a single handshake', async () => {
    const { exchange } = await sendRequestWithRaw(
      { method: 'GET', url: `${a.origin}/`, headers: {} },
      { settings: settings({ httpVersion: 'http1' }), tls: trust(), observeExchange: true }
    )
    expect(a.handshakes).toBe(1)
    expect(a.versions).toEqual(['1.1'])
    expect(exchange?.finalConnection?.tls).toMatchObject({
      protocol: expect.stringMatching(/^TLSv1\.[23]$/),
      authorized: true
    })
  })

  it('captures the TLS facts of an HTTP/2 send with a single handshake', async () => {
    const { exchange } = await sendRequestWithRaw(
      { method: 'GET', url: `${h2.origin}/`, headers: {} },
      { settings: settings({ httpVersion: 'http2' }), tls: trust(), observeExchange: true }
    )
    expect(h2.handshakes).toBe(1)
    expect(h2.versions).toEqual(['2.0'])
    expect(exchange?.finalConnection?.tls?.authorized).toBe(true)
  })

  it('captures the TLS facts of a proxied send with a single tunnel and handshake', async () => {
    const { exchange } = await sendRequestWithRaw(
      { method: 'GET', url: `${a.origin}/`, headers: {} },
      { settings: settings(), tls: trust(), proxy: proxy.config, observeExchange: true }
    )
    expect(proxy.tunnels).toBe(1)
    expect(a.handshakes).toBe(1)
    expect(exchange?.finalConnection?.tls).toBeDefined()
    expect(exchange?.finalVia).toBe('proxy')
  })

  it('reports the direct connection’s remote address, and plain http has no TLS facts', async () => {
    const plain = http.createServer((_q, r) => r.end('ok'))
    const p = await listen(
      plain,
      { origin: '', handshakes: 0, versions: [], routes: new Map(), close: async () => {} },
      'http'
    )
    try {
      const { exchange } = await sendRequestWithRaw(
        { method: 'GET', url: `${p.origin}/`, headers: {} },
        { settings: settings(), observeExchange: true }
      )
      expect(exchange?.finalVia).toBe('direct')
      expect(exchange?.finalConnection?.remoteAddress).toMatch(/^(::ffff:)?127\.0\.0\.1$/)
      expect(exchange?.finalConnection?.tls).toBeUndefined()
    } finally {
      await p.close()
    }
  })
})

describe('FIND-002 — through a proxy, the facts are the target’s', () => {
  it('describes the target certificate, not the plain-HTTP proxy', async () => {
    const trustedTarget = await sendRequestWithRaw(
      { method: 'GET', url: `${a.origin}/`, headers: {} },
      { settings: settings(), tls: trust(), proxy: proxy.config, observeExchange: true }
    )
    const untrustedTarget = await sendRequestWithRaw(
      { method: 'GET', url: `${b.origin}/`, headers: {} },
      { settings: settings(), tls: trust(), proxy: proxy.config, observeExchange: true }
    )
    expect(trustedTarget.exchange?.finalConnection?.tls?.authorized).toBe(true)
    expect(untrustedTarget.exchange?.finalConnection?.tls).toMatchObject({
      authorized: false,
      authorizationError: 'DEPTH_ZERO_SELF_SIGNED_CERT'
    })
  })
})

describe('FIND-004 — the facts belong to the origin of the final response', () => {
  it('reports the redirect target’s connection, not the first hop’s', async () => {
    a.routes.set('/start', (_q, res) => {
      res.writeHead(302, { location: `${b.origin}/final` })
      res.end()
    })
    const { exchange } = await sendRequestWithRaw(
      { method: 'GET', url: `${a.origin}/start`, headers: {} },
      { settings: settings(), tls: trust(), observeExchange: true }
    )
    expect(exchange?.finalUrl).toBe(`${b.origin}/final`)
    expect(exchange?.finalConnection?.tls?.authorized).toBe(false)
    expect(exchange?.hops.map((h) => h.url)).toEqual([`${a.origin}/start`, `${b.origin}/final`])
  })
})

describe('hop facts behind FIND-005 and FIND-006', () => {
  it('records each hop’s Set-Cookie, including a redirecting response', async () => {
    a.routes.set('/login', (_q, res) => {
      res.writeHead(302, { location: '/home', 'set-cookie': ['sid=s3cr3t; Path=/'] })
      res.end()
    })
    const { exchange } = await sendRequestWithRaw(
      { method: 'GET', url: `${a.origin}/login`, headers: {} },
      { settings: settings(), tls: trust(), observeExchange: true }
    )
    expect(exchange?.hops.map((h) => h.setCookie)).toEqual([['sid=s3cr3t; Path=/'], []])
  })

  it.each([
    [false, false],
    [true, true]
  ])(
    'records the final hop’s headers as sent (follow Authorization: %s → present: %s)',
    async (followAuthorizationOnRedirect, present) => {
      a.routes.set('/go', (_q, res) => {
        res.writeHead(302, { location: `${b.origin}/landing` })
        res.end()
      })
      const { exchange } = await sendRequestWithRaw(
        { method: 'GET', url: `${a.origin}/go`, headers: { Authorization: 'Bearer t0ken' } },
        {
          settings: settings({ followAuthorizationOnRedirect }),
          tls: trust(),
          observeExchange: true
        }
      )
      const finalHop = exchange?.hops.at(-1)
      const names = finalHop?.requestHeaders.map(([n]) => n.toLowerCase()) ?? []
      expect(names.includes('authorization')).toBe(present)
      expect(
        exchange?.hops[0].requestHeaders.some(([n]) => n.toLowerCase() === 'authorization')
      ).toBe(true)
    }
  )

  it('records a single hop with redirects off', async () => {
    const { exchange } = await sendRequestWithRaw(
      { method: 'GET', url: `${a.origin}/only?x=1`, headers: { Origin: 'https://app.example' } },
      {
        settings: settings({ followRedirects: false, maxRedirects: 0 }),
        tls: trust(),
        observeExchange: true
      }
    )
    expect(exchange?.hops).toHaveLength(1)
    expect(exchange?.finalUrl).toBe(`${a.origin}/only?x=1`)
    expect(exchange?.hops[0].requestHeaders).toContainEqual(['Origin', 'https://app.example'])
  })

  it('observes nothing unless asked', async () => {
    const result = await sendRequestWithRaw(
      { method: 'GET', url: `${a.origin}/`, headers: {} },
      { settings: settings(), tls: trust() }
    )
    expect(result.exchange).toBeUndefined()
  })
})

// ── The send pipeline ─────────────────────────────────────────────────────────

const executeOpts = (over: Partial<ExecuteOptions> = {}): ExecuteOptions => ({
  environmentId: null,
  workspaceSettings: settings(),
  resolveTls: async () => trust(),
  evaluateFindings: true,
  ...over
})

function evaluated(f: FindingsEvaluation | undefined): Finding[] {
  if (f?.status !== 'evaluated') throw new Error(`not evaluated: ${JSON.stringify(f)}`)
  return f.items
}

describe('FIND-003 — an untrusted certificate with verification off', () => {
  it('reports verification-disabled and untrusted-certificate with its error code', async () => {
    const result = await execute({ method: 'GET', url: `${b.origin}/`, headers: {} }, executeOpts())
    const items = evaluated(result.findings)
    expect(items.find((f) => f.ruleId === 'tls.verification-disabled')).toBeDefined()
    expect(items.find((f) => f.ruleId === 'tls.untrusted-certificate')?.evidence).toEqual({
      error: 'DEPTH_ZERO_SELF_SIGNED_CERT'
    })
    expect(result.findings).toMatchObject({ tls: 'captured', finalOrigin: b.origin })
  })
})

describe('FIND-005 — request-side facts are those of the final hop as sent', () => {
  it.each([
    [false, false],
    [true, true]
  ])(
    'a credential stripped on a cross-origin redirect is not "carried" (follow: %s → carried: %s)',
    async (followAuthorizationOnRedirect, carried) => {
      a.routes.set('/go', (_q, res) => {
        res.writeHead(302, { location: `${b.origin}/landing` })
        res.end()
      })
      const result = await execute(
        { method: 'GET', url: `${a.origin}/go`, headers: { Authorization: 'Bearer t0ken' } },
        executeOpts({ workspaceSettings: settings({ followAuthorizationOnRedirect }) })
      )
      // B answers without Cache-Control: cacheable whenever credentials reached it.
      const ids = evaluated(result.findings).map((f) => f.ruleId)
      expect(ids.includes('cache.sensitive-cacheable')).toBe(carried)
    }
  )
})

describe('FIND-006 — a cookie set on a redirecting hop is evaluated with its hop', () => {
  it('reports the login hop’s session cookie although the final response sets none', async () => {
    a.routes.set('/login', (_q, res) => {
      res.writeHead(302, { location: `${b.origin}/home`, 'set-cookie': ['sid=s3cr3t; Path=/'] })
      res.end()
    })
    const result = await execute(
      { method: 'GET', url: `${a.origin}/login`, headers: {} },
      executeOpts()
    )
    const cookies = evaluated(result.findings).filter((f) => f.category === 'cookies')
    expect(cookies.map((f) => [f.ruleId, f.evidence])).toEqual([
      ['cookies.missing-secure', { cookie: 'sid', hop: a.origin }],
      ['cookies.missing-httponly', { cookie: 'sid', hop: a.origin }]
    ])
    expect(JSON.stringify(result.findings)).not.toContain('s3cr3t')
  })
})

describe('FIND-016 — a real redirect to plain HTTP reaches the downgrade rule', () => {
  it('applies the rule to the chain and, the http target being loopback, does not fire it', async () => {
    const plain = http.createServer((_q, r) => r.end('landed'))
    const p = await listen(
      plain,
      { origin: '', handshakes: 0, versions: [], routes: new Map(), close: async () => {} },
      'http'
    )
    try {
      a.routes.set('/to-plain', (_q, res) => {
        res.writeHead(302, { location: `${p.origin}/landing` })
        res.end()
      })
      const send = (disabledRules: string[]) =>
        execute(
          { method: 'GET', url: `${a.origin}/to-plain`, headers: {} },
          executeOpts({ workspaceSettings: settings({ findings: { disabledRules } }) })
        )
      const on = await send([])
      const off = await send(['transport.https-downgrade'])
      expect(on.response?.body).toBe('landed')
      const onItems = evaluated(on.findings)
      evaluated(off.findings)
      expect(onItems.map((f) => f.ruleId)).not.toContain('transport.https-downgrade')
      if (on.findings?.status !== 'evaluated' || off.findings?.status !== 'evaluated') {
        throw new Error('not evaluated')
      }
      expect(on.findings.rulesApplied - off.findings.rulesApplied).toBe(1)
      expect(on.findings.finalOrigin).toBe(p.origin)
    } finally {
      await p.close()
    }
  })
})

describe('FIND-007 — the remote IP of the direct connection', () => {
  it('is reported for a direct send, evaluation or not', async () => {
    const result = await execute(
      { method: 'GET', url: `${a.origin}/`, headers: {} },
      executeOpts({ evaluateFindings: false })
    )
    expect(result.remoteIp).toMatch(/^(::1|(::ffff:)?127\.0\.0\.1)$/)
    expect(result.findings).toBeUndefined()
  })

  it('is omitted through a proxy, whose address the connection would report', async () => {
    const result = await execute(
      { method: 'GET', url: `${a.origin}/`, headers: {} },
      executeOpts({ proxy: proxy.config })
    )
    expect(result.response?.status).toBe(200)
    expect(result.remoteIp).toBeUndefined()
    expect(result.findings).toMatchObject({ status: 'evaluated', tls: 'captured' })
  })
})
