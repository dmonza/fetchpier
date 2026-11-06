import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import http from 'node:http'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import type { TLSSocket } from 'node:tls'
import { generateCACertificate, getLocal, type Mockttp } from 'mockttp'
import { execute, type ExecuteOptions } from './execute'
import { sendRequestWithRaw } from './client'
import { resolveRequestTls } from '../tls/resolve'
import { DEFAULT_WORKSPACE_HTTP_SETTINGS } from '../workspace/defaults'
import { CoreError } from '../shared/context'
import type { ClientCertEntry, HttpRequest, ProxyConfig } from '@shared/types'

/**
 * Security finding P1-2 — what a redirect hop inherits (REDIR-001..007).
 *
 * Real servers, a real forward proxy and the real transport, for the same reason
 * as `cookie-redirect-execute.test.ts`: every case rests on the transport cleaning
 * a hop and re-dispatching it *through* the interception chain, and on what
 * undici itself strips. A mocked transport would assert our belief about both.
 *
 * Client certificates are told apart by the common name the server sees on the
 * TLS connection of each hop. The servers ask for a certificate but accept any,
 * and the client does not verify them (`verifySsl: false`): selection does not
 * depend on verification, and this keeps the fixtures to three self-signed
 * identities.
 */

type Identity = { key: string; cert: string }
type Route = (res: http.ServerResponse) => void

interface Hop {
  path: string
  /** Common name of the client certificate presented on this hop's connection. */
  clientCert: string | null
}

interface TlsServer {
  origin: string
  port: number
  hops: Hop[]
  routes: Map<string, Route>
  close: () => Promise<void>
}

const redirectTo =
  (location: string): Route =>
  (res) => {
    res.writeHead(302, { location })
    res.end()
  }
const reply =
  (body: string): Route =>
  (res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(body)
  }

async function startTlsServer(identity: Identity): Promise<TlsServer> {
  const hops: Hop[] = []
  const routes = new Map<string, Route>()
  const server = https.createServer(
    { ...identity, requestCert: true, rejectUnauthorized: false },
    (req, res) => {
      const peer = (req.socket as TLSSocket).getPeerCertificate()
      const cn = peer?.subject?.CN
      hops.push({ path: req.url ?? '', clientCert: typeof cn === 'string' ? cn : null })
      const route = routes.get(req.url ?? '')
      if (route) route(res)
      else {
        res.writeHead(404)
        res.end()
      }
    }
  )
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const port = (server.address() as AddressInfo).port
  return {
    origin: `https://localhost:${port}`,
    port,
    hops,
    routes,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

let serverIdentity: Identity
let identityA: Identity
let identityB: Identity

/** Configured for `localhost:<a.port>`. */
let a: TlsServer
/** Configured for `localhost:<b.port>`. */
let b: TlsServer
/** No certificate configured for it. */
let c: TlsServer
let plain: Mockttp
let workspaceDir = ''

const clientCert = (id: string, port: number): ClientCertEntry => ({
  id,
  host: 'localhost',
  port,
  type: 'pem',
  certFile: `${id}.crt`,
  keyFile: `${id}.key`,
  passphrase: null,
  disabled: false
})

beforeAll(async () => {
  ;[serverIdentity, identityA, identityB] = await Promise.all([
    generateCACertificate({ subject: { commonName: 'localhost' } }),
    generateCACertificate({ subject: { commonName: 'client-a' } }),
    generateCACertificate({ subject: { commonName: 'client-b' } })
  ])
  ;[a, b, c] = await Promise.all([
    startTlsServer(serverIdentity),
    startTlsServer(serverIdentity),
    startTlsServer(serverIdentity)
  ])
  plain = getLocal()
  await plain.start()
}, 60_000)

afterAll(async () => {
  await Promise.all([a.close(), b.close(), c.close(), plain.stop()])
})

beforeEach(async () => {
  workspaceDir = await fs.mkdtemp(join(tmpdir(), 'redirect-hop-'))
  const certs = join(workspaceDir, '.fetchpier', 'certs')
  await fs.mkdir(certs, { recursive: true })
  for (const [id, identity] of [
    ['client-a', identityA],
    ['client-b', identityB]
  ] as const) {
    await fs.writeFile(join(certs, `${id}.crt`), identity.cert)
    await fs.writeFile(join(certs, `${id}.key`), identity.key)
  }
  await fs.writeFile(
    join(workspaceDir, '.fetchpier', 'settings.json'),
    JSON.stringify({
      http: {
        tls: {
          caCertificates: [],
          clientCertificates: [clientCert('client-a', a.port), clientCert('client-b', b.port)]
        }
      }
    })
  )
})

afterEach(async () => {
  for (const s of [a, b, c]) {
    s.hops.length = 0
    s.routes.clear()
  }
  await plain.reset()
  await fs.rm(workspaceDir, { recursive: true, force: true })
})

const opts = (over: Partial<ExecuteOptions> = {}): ExecuteOptions => ({
  environmentId: null,
  workspacePath: workspaceDir,
  workspaceSettings: {
    ...DEFAULT_WORKSPACE_HTTP_SETTINGS,
    followRedirects: true,
    maxRedirects: 5,
    verifySsl: false
  },
  resolveTls: (url, environment, onWarning) =>
    resolveRequestTls(url, environment, {
      workspacePath: workspaceDir,
      ...(onWarning ? { onWarning } : {})
    }),
  ...over
})

const get = (url: string, over: Partial<HttpRequest> = {}): HttpRequest => ({
  method: 'GET',
  url,
  headers: {},
  ...over
})

const certsSeen = (s: TlsServer): (string | null)[] => s.hops.map((h) => h.clientCert)

describe('REDIR-004 — each hop presents the client certificate of its own host', () => {
  it('gives the redirect target its own certificate, not the first host’s', async () => {
    a.routes.set('/start', redirectTo(`${b.origin}/final`))
    b.routes.set('/final', reply('b'))

    const res = await execute(get(`${a.origin}/start`), opts())

    expect(res.response?.body).toBe('b')
    expect(certsSeen(a)).toEqual(['client-a'])
    expect(certsSeen(b)).toEqual(['client-b'])
  })

  it('presents no certificate to a target that has none configured', async () => {
    a.routes.set('/start', redirectTo(`${c.origin}/final`))
    c.routes.set('/final', reply('c'))

    const res = await execute(get(`${a.origin}/start`), opts())

    expect(res.response?.body).toBe('c')
    expect(certsSeen(c)).toEqual([null])
  })

  it('keeps the certificate across a redirect that stays on the same origin', async () => {
    a.routes.set('/start', redirectTo('/final'))
    a.routes.set('/final', reply('a'))

    const res = await execute(get(`${a.origin}/start`), opts())

    expect(res.response?.body).toBe('a')
    expect(certsSeen(a)).toEqual(['client-a', 'client-a'])
  })

  it('applies fixed TLS material to the first origin only', async () => {
    // A direct caller of the client that passes material instead of a resolver:
    // the certificate it chose for the first host still does not travel.
    a.routes.set('/start', redirectTo(`${c.origin}/final`))
    c.routes.set('/final', reply('c'))

    const { response } = await sendRequestWithRaw(get(`${a.origin}/start`), {
      settings: opts().workspaceSettings,
      tls: { cert: Buffer.from(identityA.cert), key: Buffer.from(identityA.key) }
    })

    expect(response.body).toBe('c')
    expect(certsSeen(a)).toEqual(['client-a'])
    expect(certsSeen(c)).toEqual([null])
  })
})

describe('REDIR-005 — a hop from http to https resolves its TLS material', () => {
  it('presents the https host’s certificate after a plain-http first hop', async () => {
    await plain.forGet('/start').thenReply(302, undefined, { location: `${b.origin}/final` })
    b.routes.set('/final', reply('b'))

    const res = await execute(get(`${plain.url}/start`), opts())

    expect(res.response?.body).toBe('b')
    expect(certsSeen(b)).toEqual(['client-b'])
  })
})

describe('REDIR-007 — TLS failures on a later hop keep the first hop’s contract', () => {
  it('fails the send when a later hop’s passphrase secret cannot be decrypted', async () => {
    a.routes.set('/start', redirectTo(`${b.origin}/final`))
    b.routes.set('/final', reply('b'))
    let calls = 0
    const resolveTls: ExecuteOptions['resolveTls'] = async () => {
      calls += 1
      if (calls > 1) throw new CoreError('SECRETS_KEY_MISSING', 'locked')
      return {}
    }

    await expect(execute(get(`${a.origin}/start`), opts({ resolveTls }))).rejects.toMatchObject({
      code: 'SECRETS_KEY_MISSING'
    })
    expect(b.hops).toEqual([])
  })

  it('sends a later hop without material when it cannot be read, and says so once', async () => {
    a.routes.set('/start', redirectTo(`${b.origin}/final`))
    b.routes.set('/final', reply('b'))
    let calls = 0
    const resolveTls: ExecuteOptions['resolveTls'] = async (_url, _env, onWarning) => {
      calls += 1
      onWarning?.('CA certificate "corp.pem" could not be read and was skipped')
      if (calls > 1) throw new Error('unreadable client key')
      return {}
    }

    const res = await execute(get(`${a.origin}/start`), opts({ resolveTls }))

    expect(res.response?.body).toBe('b')
    expect(certsSeen(b)).toEqual([null])
    const reasons = (res.warnings ?? [])
      .filter((w) => w.code === 'TLS_MATERIAL_UNAVAILABLE')
      .map((w) => (w as { reason: string }).reason)
    expect(reasons).toEqual([
      'CA certificate "corp.pem" could not be read and was skipped',
      'unreadable client key'
    ])
  })
})

// ── Proxy, per hop ──────────────────────────────────────────────────────────

/**
 * A forward proxy that answers by itself: it records the absolute URL of every
 * request it receives and replies from {@link proxyRoutes}. A plain-http target
 * reaches an HTTP proxy in absolute form (no tunnel), so the recorded URL is the
 * hop the proxy was asked to carry.
 */
let proxy: http.Server
let proxyConfig: ProxyConfig
const proxied: string[] = []
const proxyRoutes = new Map<string, Route>()

beforeAll(async () => {
  proxy = http.createServer((req, res) => {
    proxied.push(req.url ?? '')
    const route = proxyRoutes.get(new URL(req.url ?? '', 'http://unused').pathname)
    if (route) route(res)
    else {
      res.writeHead(502)
      res.end()
    }
  })
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  proxyConfig = {
    enabled: true,
    url: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
    username: '',
    password: ''
  }
})

afterAll(async () => {
  proxy.closeAllConnections()
  await new Promise<void>((resolve) => proxy.close(() => resolve()))
})

afterEach(() => {
  proxied.length = 0
  proxyRoutes.clear()
})

describe('REDIR-006 — the proxy is decided again for every hop', () => {
  it('routes a hop through the proxy when the first host bypassed it', async () => {
    // `localhost` stands for a NO_PROXY host; `127.0.0.1` for one that is not.
    const target = plain.url.replace('localhost', '127.0.0.1')
    await plain.forGet('/start').thenReply(302, undefined, { location: `${target}/final` })
    await plain.forGet('/final').thenReply(200, 'direct')
    proxyRoutes.set('/final', reply('via-proxy'))

    const res = await execute(
      get(`${plain.url}/start`),
      opts({
        proxy: (url) => (new URL(url).hostname === 'localhost' ? undefined : proxyConfig)
      })
    )

    expect(res.response?.body).toBe('via-proxy')
    expect(proxied).toEqual([`${target}/final`])
  })

  it('sends a hop direct when its host bypasses the proxy the first hop used', async () => {
    const target = plain.url.replace('localhost', '127.0.0.1')
    proxyRoutes.set('/start', redirectTo(`${target}/final`))
    await plain.forGet('/final').thenReply(200, 'direct')

    const res = await execute(
      get(`${plain.url}/start`),
      opts({
        proxy: (url) => (new URL(url).hostname === 'localhost' ? proxyConfig : undefined)
      })
    )

    expect(res.response?.body).toBe('direct')
    expect(proxied).toEqual([`${plain.url}/start`])
  })
})

// ── Credentials, per hop ────────────────────────────────────────────────────

/**
 * `localhost` → `127.0.0.1` changes the host; a second server on another port
 * changes only the port. Both are a different origin to the transport.
 */
let otherPort: Mockttp

beforeAll(async () => {
  otherPort = getLocal()
  await otherPort.start()
})

afterAll(async () => {
  await otherPort.stop()
})

afterEach(async () => {
  await otherPort.reset()
})

const bearer = { type: 'bearer' as const, token: 'tok-redirect-1' }

describe('REDIR-001 / REDIR-002 — Authorization follows the origin rule', () => {
  const targets = {
    'the same origin': () => ({ server: plain, url: `${plain.url}/final` }),
    'another host': () => ({
      server: plain,
      url: `${plain.url.replace('localhost', '127.0.0.1')}/final`
    }),
    'another port': () => ({ server: otherPort, url: `${otherPort.url}/final` })
  }

  it.each([
    ['the same origin', false, 'Bearer tok-redirect-1'],
    ['another host', false, undefined],
    ['another port', false, undefined],
    ['another host', true, 'Bearer tok-redirect-1'],
    ['another port', true, 'Bearer tok-redirect-1']
  ] as const)(
    'a redirect to %s with followAuthorizationOnRedirect=%s sends Authorization %s',
    async (to, follow, expected) => {
      const { server, url } = targets[to]()
      await plain.forGet('/start').thenReply(302, undefined, { location: url })
      const final = await server.forGet('/final').thenReply(200, 'final')

      const res = await execute(
        get(`${plain.url}/start`, { auth: bearer }),
        opts({
          workspaceSettings: {
            ...opts().workspaceSettings,
            followAuthorizationOnRedirect: follow
          }
        })
      )

      expect(res.response?.body).toBe('final')
      expect((await final.getSeenRequests())[0].headers.authorization).toBe(expected)
    }
  )
})

describe('REDIR-003 — an API key header follows the redirect, as in Postman', () => {
  it('sends the auth block’s API key header to another origin', async () => {
    const target = `${plain.url.replace('localhost', '127.0.0.1')}/final`
    await plain.forGet('/start').thenReply(302, undefined, { location: target })
    const final = await plain.forGet('/final').thenReply(200, 'final')

    await execute(
      get(`${plain.url}/start`, {
        auth: { type: 'api-key', key: 'X-API-Key', value: 'key-redirect-1', location: 'header' }
      }),
      opts()
    )

    expect((await final.getSeenRequests())[0].headers['x-api-key']).toBe('key-redirect-1')
  })
})
