import { describe, expect, it } from 'vitest'
import {
  cacheControlDirectives,
  cspHasFrameAncestors,
  hasForwardSecrecy,
  hasVersionToken,
  isExplicitlyShareable,
  isCredentialParameterName,
  isIpLiteral,
  isLoopbackHost,
  mediaType,
  parseHsts,
  parseSetCookie,
  queryParameterNames
} from './http-facts'

describe('isLoopbackHost — W3C Secure Contexts "potentially trustworthy" hosts', () => {
  it.each([
    ['localhost', true],
    ['LOCALHOST', true],
    ['api.localhost', true],
    ['localhost.', true],
    ['127.0.0.1', true],
    ['127.0.0.2', true],
    ['127.255.255.255', true],
    ['126.255.255.255', false],
    ['128.0.0.1', false],
    ['[::1]', true],
    ['::1', true],
    ['[::2]', false],
    ['192.168.1.10', false],
    ['10.0.0.1', false],
    ['localhost.example.com', false],
    ['mylocalhost', false],
    ['team.example', false]
  ])('%s → %s', (host, expected) => {
    expect(isLoopbackHost(host)).toBe(expected)
  })
})

describe('isIpLiteral', () => {
  it.each([
    ['203.0.113.5', true],
    ['[2001:db8::1]', true],
    ['::1', true],
    ['team.example', false],
    ['localhost', false],
    ['999.1.1.1', false]
  ])('%s → %s', (host, expected) => {
    expect(isIpLiteral(host)).toBe(expected)
  })
})

describe('parseHsts — RFC 6797', () => {
  it.each([
    [undefined, undefined],
    ['max-age=31536000; includeSubDomains', { valid: true, maxAge: 31536000 }],
    ['MAX-AGE="86400"', { valid: true, maxAge: 86400 }],
    ['includeSubDomains', { valid: false }],
    ['max-age=abc', { valid: false }],
    ['max-age=', { valid: false }],
    ['max-age=0', { valid: true, maxAge: 0 }],
    // Only the first header counts; several are joined by ", ".
    ['max-age=100, max-age=31536000', { valid: true, maxAge: 100 }]
  ])('%s → %o', (value, expected) => {
    expect(parseHsts(value)).toEqual(expected)
  })
})

describe('cspHasFrameAncestors', () => {
  it.each([
    ["default-src 'self'; frame-ancestors 'none'", true],
    ["FRAME-ANCESTORS 'self'", true],
    ["default-src 'self'", false],
    ["script-src 'self' frame-ancestors.example", false],
    [undefined, false]
  ])('%s → %s', (csp, expected) => {
    expect(cspHasFrameAncestors(csp)).toBe(expected)
  })
})

describe('cacheControlDirectives', () => {
  it('lowercases directive names and ignores their values', () => {
    expect([...cacheControlDirectives('Private="set-cookie", Max-Age=60, NO-STORE')]).toEqual([
      'private',
      'max-age',
      'no-store'
    ])
  })

  it('is empty without a header', () => {
    expect(cacheControlDirectives(undefined).size).toBe(0)
  })
})

describe('isExplicitlyShareable — RFC 9111, explicit freshness only', () => {
  const now = new Date('2026-11-11T12:00:00Z')
  const tomorrow = 'Thu, 12 Nov 2026 12:00:00 GMT'
  const yesterday = 'Tue, 10 Nov 2026 12:00:00 GMT'

  it.each([
    // [Cache-Control, Expires, shareable]
    ['public', undefined, true],
    ['max-age=600', undefined, true],
    ['max-age=1', undefined, true],
    ['max-age=0', undefined, false],
    ['s-maxage=60', undefined, true],
    ['s-maxage=0', undefined, false],
    ['max-age=0, s-maxage=60', undefined, true],
    [undefined, tomorrow, true],
    [undefined, yesterday, false],
    [undefined, 'not-a-date', false],
    // An explicit Cache-Control freshness directive overrides Expires.
    ['max-age=0', tomorrow, false],
    [undefined, undefined, false],
    ['', undefined, false],
    ['must-revalidate', tomorrow, true],
    // Protections.
    ['public, private', undefined, false],
    ['max-age=600, no-store', undefined, false],
    ['max-age=600, no-cache', undefined, false],
    ['no-cache="Set-Cookie", max-age=600', undefined, false],
    ['NO-CACHE="x-foo, set-cookie", public', undefined, false],
    ['no-cache="X-Foo", max-age=600', undefined, true],
    ['private="Set-Cookie", max-age=600', undefined, false],
    ['MAX-AGE=600', undefined, true],
    ['max-age="600"', undefined, true],
    ['max-age=abc', undefined, false]
  ])('Cache-Control %s with Expires %s → %s', (cacheControl, expires, expected) => {
    expect(isExplicitlyShareable(cacheControl, expires, now)).toBe(expected)
  })
})

describe('hasForwardSecrecy', () => {
  it.each([
    ['TLSv1.3', 'TLS_AES_128_GCM_SHA256', true],
    ['TLSv1.2', 'ECDHE-RSA-AES128-GCM-SHA256', true],
    ['TLSv1.2', 'TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384', true],
    ['TLSv1.2', 'DHE-RSA-AES256-GCM-SHA384', true],
    ['TLSv1', 'EDH-RSA-DES-CBC3-SHA', true],
    ['TLSv1.2', 'AES128-GCM-SHA256', false],
    ['TLSv1.2', 'TLS_RSA_WITH_AES_256_GCM_SHA384', false],
    ['TLSv1.1', 'AES128-SHA', false]
  ])('%s %s → %s', (protocol, cipher, expected) => {
    expect(hasForwardSecrecy(protocol, cipher)).toBe(expected)
  })
})

describe('mediaType', () => {
  it.each([
    ['text/html; charset=utf-8', 'text/html'],
    ['TEXT/HTML', 'text/html'],
    ['application/json', 'application/json'],
    [undefined, '']
  ])('%s → %s', (value, expected) => {
    expect(mediaType(value)).toBe(expected)
  })
})

describe('hasVersionToken', () => {
  it.each([
    ['nginx/1.25.3', true],
    ['Apache 2.4', true],
    ['PHP/8', true],
    ['Microsoft-IIS/10.0', true],
    ['nginx', false],
    ['cloudflare', false],
    ['gunicorn', false],
    ['Express', false]
  ])('%s → %s', (value, expected) => {
    expect(hasVersionToken(value)).toBe(expected)
  })
})

describe('parseSetCookie — RFC 6265 attributes', () => {
  const now = new Date('2026-11-11T12:00:00Z')

  it('reads the name and the Secure / HttpOnly flags, case-insensitively', () => {
    expect(parseSetCookie('sid=abc; Path=/; secure; HTTPONLY', now)).toEqual({
      name: 'sid',
      secure: true,
      httpOnly: true,
      deletion: false
    })
    expect(parseSetCookie('theme=dark', now)).toEqual({
      name: 'theme',
      secure: false,
      httpOnly: false,
      deletion: false
    })
  })

  it.each([
    ['sid=; Max-Age=0', true],
    ['sid=; Max-Age=-1', true],
    ['sid=x; Max-Age=1', false],
    ['sid=; Expires=Thu, 01 Jan 1970 00:00:00 GMT', true],
    ['sid=x; Expires=Fri, 01 Jan 2100 00:00:00 GMT', false],
    // Max-Age wins over Expires.
    ['sid=x; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT', false],
    ['sid=x; Expires=not-a-date', false]
  ])('%s is a deletion: %s', (header, deletion) => {
    expect(parseSetCookie(header, now)?.deletion).toBe(deletion)
  })

  it('does not report a cookie without a name', () => {
    expect(parseSetCookie('=value; Secure', now)).toBeNull()
    expect(parseSetCookie('', now)).toBeNull()
  })
})

describe('queryParameterNames', () => {
  it('returns the decoded parameter names in order', () => {
    expect(queryParameterNames('https://x.example/p?a=1&api%5Fkey=2&b&a=3')).toEqual([
      'a',
      'api_key',
      'b',
      'a'
    ])
  })

  it('is empty without a query, and tolerates a malformed escape', () => {
    expect(queryParameterNames('https://x.example/p')).toEqual([])
    expect(queryParameterNames('https://x.example/p?%E0=1&ok=2')).toEqual(['%E0', 'ok'])
  })
})

describe('isCredentialParameterName', () => {
  it.each([
    ['token', true],
    ['access_token', true],
    ['Access_Token', true],
    ['api-key', true],
    ['API_KEY', true],
    ['apikey', true],
    ['key', true],
    ['secret', true],
    ['password', true],
    ['pwd', true],
    ['auth', true],
    ['sort_key', false],
    ['monkey', false],
    ['tokens', false],
    ['author', false],
    ['page', false]
  ])('%s → %s', (name, expected) => {
    expect(isCredentialParameterName(name)).toBe(expected)
  })
})
