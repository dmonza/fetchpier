import { describe, it, expect } from 'vitest'
import { Cookie as LibCookie, CookieJar as LibJar } from 'tough-cookie'
import type { Cookie } from '@shared/types'
import {
  buildLibJar,
  classifyRejection,
  drainLibJar,
  fromLibCookie,
  identityKey,
  toLibCookie
} from './cookie-store'

function record(over: Partial<Cookie> = {}): Cookie {
  return {
    id: 'id-1',
    name: 'sid',
    value: 'abc',
    domain: 'example.test',
    path: '/',
    expires: null,
    maxAge: null,
    secure: false,
    httpOnly: false,
    sameSite: null,
    hostOnly: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    source: 'response',
    ...over
  }
}

describe('identityKey', () => {
  it('is the (domain, path, name) triple the library also stores by', () => {
    expect(identityKey('example.test', '/', 'sid')).toBe(identityKey('example.test', '/', 'sid'))
    expect(identityKey('example.test', '/', 'sid')).not.toBe(
      identityKey('example.test', '/a', 'sid')
    )
    expect(identityKey('example.test', '/', 'sid')).not.toBe(identityKey('other.test', '/', 'sid'))
  })

  it('does not collide when a separator appears inside a component', () => {
    // A naive `${a}-${b}-${c}` join collides here; the key must not.
    expect(identityKey('a', '/b', 'c')).not.toBe(identityKey('a/b', '', 'c'))
  })
})

describe('toLibCookie / fromLibCookie round-trip', () => {
  it('preserves every attribute through a round-trip', () => {
    const original = record({
      name: 'token',
      value: 'v1',
      domain: 'api.example.test',
      path: '/admin',
      expires: '2030-06-01T12:00:00.000Z',
      maxAge: 3600,
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
      hostOnly: false
    })
    const back = fromLibCookie(toLibCookie(original), original)
    expect(back).toEqual(original)
  })

  it('maps a session cookie (no expiry) in both directions', () => {
    const lib = toLibCookie(record({ expires: null, maxAge: null }))
    expect(lib.expires).toBe('Infinity')
    expect(lib.maxAge).toBeNull()
    expect(fromLibCookie(lib, record()).expires).toBeNull()
    expect(fromLibCookie(lib, record()).maxAge).toBeNull()
  })

  it('carries updatedAt as the library lastAccessed, which drives Max-Age expiry', () => {
    // The single most important mapping in this module: the library measures a
    // relative lifetime from `lastAccessed`, not from `creation`.
    const lib = toLibCookie(record({ maxAge: 60, updatedAt: '2026-03-01T00:00:00.000Z' }))
    expect(lib.lastAccessed).toEqual(new Date('2026-03-01T00:00:00.000Z'))
    expect(lib.expiryTime()).toBe(new Date('2026-03-01T00:00:00.000Z').getTime() + 60_000)
  })

  it('lowercases the cross-site attribute for the library and restores our casing', () => {
    expect(toLibCookie(record({ sameSite: 'Strict' })).sameSite).toBe('strict')
    const lib = LibCookie.parse('a=b; SameSite=None')!
    expect(fromLibCookie(lib, record()).sameSite).toBe('None')
  })

  it('mints a new identity when there is no previous record', () => {
    const lib = LibCookie.parse('fresh=1')!
    lib.domain = 'example.test'
    lib.path = '/'
    const out = fromLibCookie(lib, undefined)
    expect(out.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(out.source).toBe('response')
  })

  it('preserves id and source from the previous record', () => {
    const prev = { id: 'stable', createdAt: '2020-01-01T00:00:00.000Z', source: 'manual' as const }
    const lib = toLibCookie(record({ value: 'changed' }))
    const out = fromLibCookie(lib, prev)
    expect(out.id).toBe('stable')
    expect(out.source).toBe('manual')
    expect(out.value).toBe('changed')
  })

  it('takes createdAt from the library, which always carries one', () => {
    // On replacement the library copies `creation` from the cookie it replaces, so
    // its value is authoritative. It also substitutes `now` when construction gets
    // no usable date, which is why no fallback of ours is needed — asserted here
    // so an upgrade that drops the substitution is caught.
    const lib = toLibCookie(record({ createdAt: '2026-01-01T00:00:00.000Z' }))
    const prev = { id: 'x', createdAt: '2020-01-01T00:00:00.000Z', source: 'response' as const }
    expect(fromLibCookie(lib, prev).createdAt).toBe('2026-01-01T00:00:00.000Z')

    // `cookies.json` is hand-editable, so an unparseable timestamp is reachable.
    const undated = toLibCookie(record({ createdAt: 'not-a-date' }))
    expect(undated.creation).toBeInstanceOf(Date)
    expect(fromLibCookie(undated, prev).createdAt).not.toBe('')
  })
})

describe('buildLibJar / drainLibJar', () => {
  it('round-trips a set of records through a library jar, preserving ids', async () => {
    const records = [
      record({ id: 'a', name: 'one', path: '/' }),
      record({ id: 'b', name: 'two', path: '/admin' }),
      record({ id: 'c', name: 'one', domain: 'other.test' })
    ]
    const { jar, previous } = await buildLibJar(records)
    const out = await drainLibJar(jar, previous)
    expect(out.map((c) => c.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('produces a jar that rejects public suffixes and enforces prefixes strictly', async () => {
    const { jar } = await buildLibJar([])
    await expect(jar.setCookie('x=1; Domain=com', 'https://any.com/')).rejects.toThrow()
    await expect(jar.setCookie('__Secure-x=1', 'https://a.example.test/')).rejects.toThrow()
  })

  it('accepts a special-use domain so local targets keep working', async () => {
    // Every workspace fixture and integration target in this project is a local
    // host. If this regresses, the whole suite goes red for the wrong reason.
    const { jar } = await buildLibJar([])
    await expect(jar.setCookie('x=1', 'http://localhost:9200/')).resolves.toBeDefined()
  })
})

describe('classifyRejection', () => {
  // Pinning tests: the library reports rejections as Error with distinguishable
  // messages but no codes. If an upgrade rewords them, these fail loudly instead
  // of silently degrading every reason to the generic fallback.
  const jar = (): LibJar => new LibJar(undefined, { prefixSecurity: 'strict' })

  it('classifies a domain that does not cover the offering host', async () => {
    const err = await jar()
      .setCookie('sid=1; Domain=victim.test', 'https://attacker.test/cb')
      .catch((e) => e)
    expect(classifyRejection(err)).toBe('DOMAIN_MISMATCH')
  })

  it('classifies a domain that is a public suffix', async () => {
    const err = await jar()
      .setCookie('sid=1; Domain=co.uk', 'https://a.co.uk/')
      .catch((e) => e)
    expect(classifyRejection(err)).toBe('PUBLIC_SUFFIX')
  })

  it('classifies a secure-prefix violation', async () => {
    const err = await jar()
      .setCookie('__Secure-a=1', 'https://a.example.test/')
      .catch((e) => e)
    expect(classifyRejection(err)).toBe('PREFIX_VIOLATION')
  })

  it('classifies a host-prefix violation', async () => {
    const err = await jar()
      .setCookie('__Host-a=1; Secure; Domain=example.test; Path=/', 'https://a.example.test/')
      .catch((e) => e)
    expect(classifyRejection(err)).toBe('PREFIX_VIOLATION')
  })

  it('falls back to the generic reason for an unrecognised error', () => {
    expect(classifyRejection(new Error('something entirely new'))).toBe('REJECTED')
    expect(classifyRejection('not even an error')).toBe('REJECTED')
  })
})
