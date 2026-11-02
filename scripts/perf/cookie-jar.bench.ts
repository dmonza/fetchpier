import { bench, describe } from 'vitest'
import { Cookie as LibCookie } from 'tough-cookie'
import { matchesRequest } from '../../src/main/http/cookie-jar'
import type { Cookie } from '../../src/shared/types'
import { buildCookieList } from './fixtures'

// REQ-0115: the hand-written `parseSetCookieHeader` is gone — parsing is now the
// reference implementation's, reached through `captureFromResponse`. The parse
// benchmark therefore measures the library's parser directly (the thing that now
// runs on that path); the match benchmark still measures our own predicate,
// which is the code we can regress.

const headers = buildCookieList(50)
const longHeaders = buildCookieList(500)
const requestUrl = 'https://api.example.com/api/1/items'

function toCookie(header: string): Cookie {
  const p = LibCookie.parse(header)!
  return {
    id: 'id',
    name: p.key,
    value: p.value,
    domain: (p.domain ?? 'api.example.com').toLowerCase(),
    path: p.path ?? '/',
    expires: p.expires && p.expires !== 'Infinity' ? p.expires.toISOString() : null,
    maxAge: typeof p.maxAge === 'number' ? p.maxAge : null,
    secure: p.secure,
    httpOnly: p.httpOnly,
    sameSite: null,
    hostOnly: p.domain == null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: 'response'
  }
}

const cookies: Cookie[] = headers.map(toCookie)
const manyCookies: Cookie[] = longHeaders.map(toCookie)

describe('Set-Cookie parsing', () => {
  bench('single cookie', () => {
    LibCookie.parse(headers[0])
  })
  bench('batch 50', () => {
    for (const h of headers) LibCookie.parse(h)
  })
  bench('batch 500', () => {
    for (const h of longHeaders) LibCookie.parse(h)
  })
})

describe('matchesRequest', () => {
  bench('filter 50 cookies', () => {
    cookies.filter((c) => matchesRequest(c, requestUrl))
  })
  bench('filter 500 cookies', () => {
    manyCookies.filter((c) => matchesRequest(c, requestUrl))
  })
})
