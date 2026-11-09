import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { getLocal, type Mockttp } from 'mockttp'
import { execute } from './execute'
import { list } from './cookie-jar'
import { DEFAULT_WORKSPACE_HTTP_SETTINGS } from '../workspace/defaults'
import type { HttpRequest } from '@shared/types'

/**
 * REQ-0115 — the cookie jar across a redirect chain (COOKIE-001..004).
 *
 * These run against a real server through the real transport on purpose. The
 * whole mechanism rests on an ordering property of the transport — that it
 * cleans a hop's headers and then re-dispatches *through* the interception
 * chain — and a mocked transport would assert our belief about that ordering
 * rather than the ordering itself. If a transport upgrade changes it, these go
 * red instead of the product silently going back to capturing nothing.
 *
 * **Two hosts, one server.** Cookies are scoped by host and ignore the port
 * (RFC 6265 §1), so two local servers on different ports are the *same* cookie
 * host and prove nothing about crossing a boundary. `localhost` and `127.0.0.1`
 * are different hosts to the jar and different origins to the transport, while
 * reaching the same mock — which is exactly the discriminator these cases need.
 */

let server: Mockttp
let workspaceDir = ''

/** The two names the same mock answers to. Different cookie hosts, same server. */
let hostA = ''
let hostB = ''

beforeAll(async () => {
  server = getLocal()
  await server.start()
  hostA = server.url
  hostB = server.url.replace('localhost', '127.0.0.1')
})

afterAll(async () => {
  await server.stop()
})

beforeEach(async () => {
  workspaceDir = await fs.mkdtemp(join(tmpdir(), 'cookie-redirect-'))
  const envDir = join(workspaceDir, 'environments', 'dev')
  await fs.mkdir(envDir, { recursive: true })
  await fs.writeFile(
    join(envDir, 'config.json'),
    JSON.stringify({ id: 'dev', name: 'dev', variables: {} })
  )
})

afterEach(async () => {
  await server.reset()
  await fs.rm(workspaceDir, { recursive: true, force: true })
})

const opts = (): Parameters<typeof execute>[1] => ({
  environmentId: 'dev',
  workspacePath: workspaceDir,
  workspaceSettings: { ...DEFAULT_WORKSPACE_HTTP_SETTINGS, followRedirects: true, maxRedirects: 5 }
})

const get = (url: string, over: Partial<HttpRequest> = {}): HttpRequest => ({
  method: 'GET',
  url,
  headers: {},
  ...over
})

const names = async (): Promise<string[]> =>
  (await list(workspaceDir, 'dev')).map((c) => c.name).sort()

describe('COOKIE-001 — a cookie set on a redirect hop is captured', () => {
  it('captures the session a login hands over on a 302', async () => {
    // The canonical login flow: the session cookie rides the redirect, not the
    // final response. Before REQ-0115 this captured nothing at all.
    await server
      .forGet('/login')
      .thenReply(302, undefined, { location: '/dashboard', 'set-cookie': 'sid=granted' })
    await server.forGet('/dashboard').thenReply(200, 'welcome')

    const res = await execute(get(`${hostA}/login`), opts())

    expect(res.response?.status).toBe(200)
    const stored = await list(workspaceDir, 'dev')
    expect(stored.map((c) => c.name)).toEqual(['sid'])
    expect(stored[0].value).toBe('granted')
    // Attributed to the hop that offered it, which is what makes a multi-hop
    // chain readable in the Cookies section.
    expect(res.cookies?.received.map((c) => c.url)).toEqual([`${hostA}/login`])
  })

  it('attributes a cookie to the host that answered, not to the one typed', async () => {
    await server.forGet('/start').thenReply(302, undefined, { location: `${hostB}/land` })
    await server.forGet('/land').thenReply(200, 'ok', { 'set-cookie': 'from=second' })

    await execute(get(`${hostA}/start`), opts())

    const stored = await list(workspaceDir, 'dev')
    expect(stored).toHaveLength(1)
    expect(stored[0].domain).toBe('127.0.0.1')
    expect(stored[0].hostOnly).toBe(true)
  })
})

describe('COOKIE-002 — cookies are recomputed per hop and never cross a host', () => {
  it('sends each host only the cookies scoped to it', async () => {
    // One endpoint, two identities: the cookie it hands out depends on which
    // name the caller used, so each host ends up with its own.
    await server.forGet('/seed').thenCallback((req) => ({
      statusCode: 200,
      headers: {
        'set-cookie': new URL(req.url).hostname === 'localhost' ? 'first=A' : 'second=B'
      }
    }))
    await execute(get(`${hostA}/seed`), opts())
    await execute(get(`${hostB}/seed`), opts())
    expect(await names()).toEqual(['first', 'second'])

    const hop1 = await server
      .forGet('/hop')
      .thenReply(302, undefined, { location: `${hostB}/final` })
    const hop2 = await server.forGet('/final').thenReply(200, 'done')

    await execute(get(`${hostA}/hop`), opts())

    expect((await hop1.getSeenRequests())[0].headers.cookie).toBe('first=A')
    // The transport strips `Cookie` when the origin changes; this is the proof
    // that the interceptor puts back the RIGHT cookie for the new host rather
    // than forwarding the previous hop's.
    expect((await hop2.getSeenRequests())[0].headers.cookie).toBe('second=B')
  })

  it('sends nothing to a host with no cookies scoped to it', async () => {
    await server.forGet('/seed').thenReply(200, 'ok', { 'set-cookie': 'only=here' })
    await execute(get(`${hostA}/seed`), opts())

    const hop1 = await server
      .forGet('/hop')
      .thenReply(302, undefined, { location: `${hostB}/final` })
    const hop2 = await server.forGet('/final').thenReply(200, 'done')
    await execute(get(`${hostA}/hop`), opts())

    expect((await hop1.getSeenRequests())[0].headers.cookie).toBe('only=here')
    expect((await hop2.getSeenRequests())[0].headers.cookie).toBeUndefined()
  })

  it('sends a cookie set by an earlier hop to a later hop on the same host', async () => {
    // Capture-then-attach within a single send: the composition neither
    // COOKIE-001 nor the scoping case covers on its own.
    await server.forGet('/a').thenReply(302, undefined, { location: '/b', 'set-cookie': 'mid=set' })
    const last = await server.forGet('/b').thenReply(200, 'ok')

    await execute(get(`${hostA}/a`), opts())

    expect((await last.getSeenRequests())[0].headers.cookie).toBe('mid=set')
  })
})

describe('COOKIE-003 — a disabled jar disables every hop', () => {
  it('neither attaches nor captures on any hop', async () => {
    await server.forGet('/seed').thenReply(200, 'ok', { 'set-cookie': 'pre=existing' })
    await execute(get(`${hostA}/seed`), opts())

    const hop1 = await server
      .forGet('/hop')
      .thenReply(302, undefined, { location: '/final', 'set-cookie': 'new=nope' })
    const hop2 = await server.forGet('/final').thenReply(200, 'ok', { 'set-cookie': 'also=nope' })

    await execute(get(`${hostA}/hop`, { disableCookieJar: true }), opts())

    expect((await hop1.getSeenRequests())[0].headers.cookie).toBeUndefined()
    expect((await hop2.getSeenRequests())[0].headers.cookie).toBeUndefined()
    expect(await names()).toEqual(['pre'])
  })
})

describe('COOKIE-008 — the response cookies are reported even when the jar is not involved', () => {
  // The bug this covers: the Cookies section claimed "the response offered no
  // cookies" on a response that plainly did. It was reporting what the jar had
  // *stored*, and the jar does not run without an environment, with an explicit
  // Cookie header, or when disabled — three states it silently collapsed into
  // "the server sent nothing".

  it('reports them with no environment selected', async () => {
    await server.forGet('/x').thenReply(200, 'ok', { 'set-cookie': 'sid=1; Path=/' })
    const res = await execute(get(`${hostA}/x`), {
      environmentId: null,
      workspacePath: workspaceDir,
      workspaceSettings: DEFAULT_WORKSPACE_HTTP_SETTINGS
    })
    expect(res.cookies?.received.map((c) => c.name)).toEqual(['sid'])
    // Nothing decided either way — the jar never looked.
    expect(res.cookies?.received[0].stored).toBeUndefined()
  })

  it('reports them when the jar is disabled for the request', async () => {
    await server.forGet('/x').thenReply(200, 'ok', { 'set-cookie': 'sid=1; Path=/' })
    const res = await execute(get(`${hostA}/x`, { disableCookieJar: true }), opts())
    expect(res.cookies?.received.map((c) => c.name)).toEqual(['sid'])
  })

  it('sends only the hand-written Cookie header, and still captures the response', async () => {
    // The two directions are independent. A hand-written header decides what goes
    // OUT; it says nothing about whether the session the server hands back is
    // worth keeping. `disableCookieJar` is the switch for "stay out entirely".
    await server.forGet('/seed').thenReply(200, 'ok', { 'set-cookie': 'stored=jar; Path=/' })
    await execute(get(`${hostA}/seed`), opts())
    expect(await names()).toEqual(['stored'])

    const endpoint = await server
      .forGet('/x')
      .thenReply(200, 'ok', { 'set-cookie': 'fresh=2; Path=/' })
    const res = await execute(get(`${hostA}/x`, { headers: { Cookie: 'mine=1' } }), opts())

    // Only what the author wrote goes on the wire — the jar's `stored=jar` is not
    // merged in, so two cookies can never collide on one name.
    expect((await endpoint.getSeenRequests())[0].headers.cookie).toBe('mine=1')
    expect(res.cookies?.sent ?? []).toHaveLength(0)

    // …and the response's cookie is kept, not discarded.
    expect(res.cookies?.received.map((c) => c.name)).toEqual(['fresh'])
    expect(res.cookies?.received[0].stored).toBe(true)
    expect(await names()).toEqual(['fresh', 'stored'])
  })

  it('does not restore a hand-written Cookie header across a cross-origin hop', async () => {
    // The transport strips it when the origin changes, and capture-only mode
    // leaves the header alone rather than putting it back — a cookie the author
    // wrote for one host has no business reaching another.
    await server.forGet('/a').thenReply(302, undefined, { location: `${hostB}/b` })
    const landing = await server.forGet('/b').thenReply(200, 'ok')

    await execute(get(`${hostA}/a`, { headers: { Cookie: 'mine=1' } }), opts())

    expect((await landing.getSeenRequests())[0].headers.cookie).toBeUndefined()
  })

  it('carries the attributes the section renders', async () => {
    await server
      .forGet('/x')
      .thenReply(200, 'ok', { 'set-cookie': 'sid=1; Path=/app; HttpOnly; Max-Age=60' })
    const res = await execute(get(`${hostA}/x`), opts())
    const row = res.cookies!.received[0]
    expect(row.path).toBe('/app')
    expect(row.httpOnly).toBe(true)
    expect(row.secure).toBe(false)
    // A relative lifetime is resolved to an absolute instant here, so no
    // consumer has to know the receipt time to render it.
    expect(Date.parse(row.expires!)).toBeGreaterThan(Date.now())
  })

  it('lists a cookie the jar refused, flagged as not stored', async () => {
    await server.forGet('/x').thenReply(200, 'ok', { 'set-cookie': 'sid=1; Domain=unrelated.test' })
    const res = await execute(get(`${hostA}/x`), opts())
    expect(res.cookies?.received.map((c) => c.name)).toEqual(['sid'])
    expect(res.cookies?.received[0].stored).toBe(false)
    expect(await list(workspaceDir, 'dev')).toHaveLength(0)
  })
})

describe('COOKIE-004 — rejections surface as warnings on the send', () => {
  it('reports a cookie the jar refused, without failing the send', async () => {
    await server
      .forGet('/evil')
      .thenReply(200, 'ok', { 'set-cookie': 'sid=1; Domain=unrelated.test' })

    const res = await execute(get(`${hostA}/evil`), opts())

    expect(res.response?.status).toBe(200)
    expect(res.error).toBeUndefined()
    expect(res.warnings).toEqual([
      expect.objectContaining({ code: 'COOKIE_REJECTED', name: 'sid', reason: 'DOMAIN_MISMATCH' })
    ])
    expect(await list(workspaceDir, 'dev')).toHaveLength(0)
  })

  it('keeps cookies captured before a later hop fails', async () => {
    // The chain hands over its session and then dies. Dropping the cookie would
    // make the user's retry mysteriously unauthenticated.
    await server
      .forGet('/half')
      .thenReply(302, undefined, { location: `${hostB}/gone`, 'set-cookie': 'sid=kept' })
    await server.forGet('/gone').thenCloseConnection()

    const res = await execute(get(`${hostA}/half`), opts())

    expect(res.error).toBeDefined()
    expect(await names()).toEqual(['sid'])
  })
})

describe('COOKIE-011 — a two-slash path does not change whose cookies apply', () => {
  /** A request to hostB whose path names hostA: the connection stays on hostB. */
  const pathNamingA = (): string => `//${hostA.replace('http://', '')}/resource`

  const seedHostA = async (): Promise<void> => {
    await server.forGet('/seed').thenReply(200, 'ok', { 'set-cookie': 'session=of-a' })
    await execute(get(`${hostA}/seed`), opts())
  }

  it('does not send the named host’s cookie on a direct request', async () => {
    await seedHostA()
    const hit = await server.forAnyRequest().thenReply(200, 'ok')

    await execute(get(`${hostB}${pathNamingA()}`), opts())

    const seen = await hit.getSeenRequests()
    expect(seen).toHaveLength(1)
    expect(seen[0].headers.cookie).toBeUndefined()
  })

  it('does not send the named host’s cookie on a redirect to a two-slash path', async () => {
    await seedHostA()
    await server
      .forGet('/start')
      .thenReply(302, undefined, { location: `${hostB}${pathNamingA()}` })
    const hit = await server.forAnyRequest().thenReply(200, 'ok')

    await execute(get(`${hostB}/start`), opts())

    const seen = await hit.getSeenRequests()
    expect(seen).toHaveLength(1)
    expect(seen[0].headers.cookie).toBeUndefined()
  })

  it('does not send the named host’s cookie when redirects are off', async () => {
    await seedHostA()
    const hit = await server.forAnyRequest().thenReply(200, 'ok')

    await execute(get(`${hostB}${pathNamingA()}`), {
      ...opts(),
      workspaceSettings: { ...DEFAULT_WORKSPACE_HTTP_SETTINGS, followRedirects: false }
    })

    const seen = await hit.getSeenRequests()
    expect(seen).toHaveLength(1)
    expect(seen[0].headers.cookie).toBeUndefined()
  })

  it('stores a received cookie for the host that answered, not the one named', async () => {
    await server.forAnyRequest().thenReply(200, 'ok', { 'set-cookie': 'planted=1' })

    const res = await execute(get(`${hostB}${pathNamingA()}`), opts())

    const stored = await list(workspaceDir, 'dev')
    expect(stored.map((c) => c.domain)).toEqual(['127.0.0.1'])
    expect(res.cookies?.received.map((c) => c.url)).toEqual([`${hostB}${pathNamingA()}`])
  })

  it('sends the real host its own cookie on a two-slash path', async () => {
    await server.forGet('/seed').thenReply(200, 'ok', { 'set-cookie': 'own=yes; Path=/' })
    await execute(get(`${hostB}/seed`), opts())
    const hit = await server.forAnyRequest().thenReply(200, 'ok')

    await execute(get(`${hostB}//users`), opts())

    expect((await hit.getSeenRequests())[0].headers.cookie).toBe('own=yes')
  })
})
