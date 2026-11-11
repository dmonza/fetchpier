import { describe, expect, it } from 'vitest'
import { resolveFindingsSettings } from '@shared/lib/findings'
import type { Finding } from '@shared/types'
import { evaluateFindings } from './evaluate'
import type { FindingsExchange } from './types'

const NOW = new Date('2026-11-11T12:00:00Z')
const DAY = 86_400_000

/**
 * A clean HTTPS exchange: modern TLS, a sound certificate and the headers every
 * rule looks for. Evaluated, it fires nothing; each case below changes one thing.
 */
function clean(over: Partial<FindingsExchange> = {}): FindingsExchange {
  return {
    finalUrl: 'https://api.example/resource',
    requestHeaders: [['Accept', 'application/json']],
    response: {
      headers: {
        'content-type': 'application/json',
        'strict-transport-security': 'max-age=31536000',
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store'
      },
      hasBody: true
    },
    hops: [{ url: 'https://api.example/resource', setCookie: [] }],
    tls: {
      protocol: 'TLSv1.3',
      cipher: 'TLS_AES_256_GCM_SHA384',
      authorized: true,
      certificate: { validTo: new Date(NOW.getTime() + 365 * DAY), keyType: 'rsa', bits: 2048 }
    },
    verifySsl: true,
    ...over
  }
}

function withHeaders(
  headers: Record<string, string | undefined>,
  over: Partial<FindingsExchange> = {}
): FindingsExchange {
  const base = clean(over)
  const merged: Record<string, string> = { ...base.response.headers }
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) delete merged[k]
    else merged[k] = v
  }
  return { ...base, response: { ...base.response, headers: merged } }
}

const run = (
  ex: FindingsExchange,
  raw: unknown = undefined
): Extract<ReturnType<typeof evaluateFindings>, { status: 'evaluated' }> =>
  evaluateFindings(ex, resolveFindingsSettings(raw), NOW)

const ids = (items: Finding[]): string[] => items.map((f) => f.ruleId)
const one = (items: Finding[], id: string): Finding | undefined =>
  items.find((f) => f.ruleId === id)

describe('baseline', () => {
  it('a clean HTTPS exchange fires nothing, counting every rule whose scope held', () => {
    const r = run(clean())
    expect(r.items).toEqual([])
    // transport ×2, tls ×8, hsts ×2, nosniff, cors-wildcard, cors-null, version,
    // credentials-in-query.
    expect(r.rulesApplied).toBe(17)
    expect(r.tls).toBe('captured')
    expect(r.finalOrigin).toBe('https://api.example')
  })
})

describe('transport (CA-04, CA-05)', () => {
  const http = (url: string, requestHeaders: Array<[string, string]> = []): FindingsExchange =>
    clean({ finalUrl: url, requestHeaders, hops: [{ url, setCookie: [] }], tls: undefined })

  it('plain http without credentials → transport.plaintext', () => {
    const r = run(http('http://team.example/x'))
    expect(ids(r.items)).toContain('transport.plaintext')
    expect(ids(r.items)).not.toContain('transport.plaintext-credentials')
    expect(r.tls).toBe('not-applicable')
  })

  it.each([
    [[['Authorization', 'Bearer SENTINEL']] as Array<[string, string]>, 'authorization'],
    [[['Cookie', 'sid=SENTINEL']] as Array<[string, string]>, 'cookie']
  ])('plain http carrying %j → only plaintext-credentials, carrier %s', (headers, carrier) => {
    const r = run(http('http://team.example/x', headers))
    expect(one(r.items, 'transport.plaintext-credentials')?.evidence).toEqual({ carrier })
    expect(ids(r.items)).not.toContain('transport.plaintext')
  })

  it.each([
    ['header', [['X-Api-Key', 'SENTINEL']] as Array<[string, string]>, 'http://team.example/x'],
    ['query', [] as Array<[string, string]>, 'http://team.example/x?X-Api-Key=SENTINEL']
  ])('an API-key scheme in the %s is an auth-scheme carrier', (location, headers, url) => {
    const r = run({
      ...http(url, headers),
      auth: { type: 'api-key', key: 'X-Api-Key', value: '', location: location as 'header' }
    })
    expect(one(r.items, 'transport.plaintext-credentials')?.evidence).toEqual({
      carrier: 'auth-scheme'
    })
  })

  it.each([
    'http://localhost:3000/x',
    'http://api.localhost/x',
    'http://127.0.0.2/x',
    'http://[::1]/x'
  ])('loopback %s: no transport rule fires or counts', (url) => {
    const r = run(http(url, [['Authorization', 'Bearer t']]))
    expect(ids(r.items).filter((i) => i.startsWith('transport.'))).toEqual([])
    const counted = run(http(url)).rulesApplied
    const nonLoopback = run(http('http://team.example/x')).rulesApplied
    expect(nonLoopback - counted).toBe(2)
  })

  it('a private-network host is not loopback', () => {
    const r = run(http('http://192.168.1.10/x', [['Authorization', 'Bearer t']]))
    expect(ids(r.items)).toContain('transport.plaintext-credentials')
  })
})

describe('tls (CA-03, CA-07..CA-10)', () => {
  it('unavailable TLS details: no TLS-detail rule fires or counts; others still evaluate', () => {
    const r = run(withHeaders({ 'x-content-type-options': undefined }, { tls: undefined }))
    expect(r.tls).toBe('unavailable')
    expect(ids(r.items)).toEqual(['headers.nosniff-missing'])
    // 17 − the seven rules that need captured TLS details.
    expect(r.rulesApplied).toBe(10)
  })

  it('verification-disabled fires on https only', () => {
    expect(ids(run(clean({ verifySsl: false })).items)).toEqual(['tls.verification-disabled'])
    const http = run(
      clean({ finalUrl: 'http://team.example/', verifySsl: false, tls: undefined, hops: [] })
    )
    expect(ids(http.items)).not.toContain('tls.verification-disabled')
  })

  it('an untrusted certificate with verification off names its error code', () => {
    const tls = {
      ...clean().tls!,
      authorized: false,
      authorizationError: 'DEPTH_ZERO_SELF_SIGNED_CERT'
    }
    const r = run(clean({ verifySsl: false, tls }))
    expect(ids(r.items)).toEqual(['tls.untrusted-certificate', 'tls.verification-disabled'])
    expect(one(r.items, 'tls.untrusted-certificate')?.evidence).toEqual({
      error: 'DEPTH_ZERO_SELF_SIGNED_CERT'
    })
  })

  it('an expired certificate whose only error is the expiry supersedes untrusted-certificate', () => {
    const tls = {
      ...clean().tls!,
      authorized: false,
      authorizationError: 'CERT_HAS_EXPIRED',
      certificate: { ...clean().tls!.certificate, validTo: new Date(NOW.getTime() - 2.5 * DAY) }
    }
    const r = run(clean({ verifySsl: false, tls }))
    expect(ids(r.items)).toEqual(['tls.certificate-expired', 'tls.verification-disabled'])
    expect(one(r.items, 'tls.certificate-expired')?.evidence).toEqual({ daysAgo: '3' })
  })

  it('an expired, self-signed certificate reports both', () => {
    const tls = {
      ...clean().tls!,
      authorized: false,
      authorizationError: 'DEPTH_ZERO_SELF_SIGNED_CERT',
      certificate: { ...clean().tls!.certificate, validTo: new Date(NOW.getTime() - DAY) }
    }
    expect(ids(run(clean({ verifySsl: false, tls })).items)).toEqual([
      'tls.certificate-expired',
      'tls.untrusted-certificate',
      'tls.verification-disabled'
    ])
  })

  it.each([
    ['TLSv1.1', true],
    ['TLSv1', true],
    ['SSLv3', true],
    ['TLSv1.2', false],
    ['TLSv1.3', false]
  ])('protocol %s is legacy: %s', (protocol, legacy) => {
    const r = run(clean({ tls: { ...clean().tls!, protocol } }))
    expect(one(r.items, 'tls.legacy-protocol')?.evidence).toEqual(legacy ? { protocol } : undefined)
  })

  it.each([
    ['ECDHE-RSA-AES128-SHA', true],
    ['TLS_RSA_WITH_3DES_EDE_CBC_SHA', true],
    ['RC4-SHA', true],
    ['NULL-SHA256', true],
    ['TLS_AES_128_GCM_SHA256', false],
    ['TLS_CHACHA20_POLY1305_SHA256', false],
    ['TLS_AES_128_CCM_SHA256', false]
  ])('cipher %s is non-AEAD: %s', (cipher, nonAead) => {
    const r = run(clean({ tls: { ...clean().tls!, cipher } }))
    expect(one(r.items, 'tls.non-aead-cipher')?.evidence).toEqual(nonAead ? { cipher } : undefined)
  })

  it.each([
    ['rsa', 1024, true],
    ['rsa', 2047, true],
    ['rsa', 2048, false],
    ['dsa', 1024, true],
    ['ec', 224, true],
    ['ec', 256, false],
    ['ed25519', undefined, false]
  ])('%s %s-bit key is weak: %s', (keyType, bits, weak) => {
    const certificate = {
      validTo: clean().tls!.certificate.validTo,
      keyType,
      ...(bits ? { bits } : {})
    }
    const r = run(clean({ tls: { ...clean().tls!, certificate } }))
    expect(one(r.items, 'tls.weak-key')?.evidence).toEqual(
      weak ? { keyType, bits: String(bits) } : undefined
    )
  })

  it.each([
    [30, undefined, '30'],
    [31, undefined, undefined],
    [29.2, undefined, '30'],
    [0.5, 0, undefined],
    [5, 0, undefined],
    [5, 7, '5']
  ])(
    'a leaf with %s days left (window %s) fires expiring with daysLeft %s',
    (left, window, expected) => {
      const certificate = {
        ...clean().tls!.certificate,
        validTo: new Date(NOW.getTime() + left * DAY)
      }
      const r = run(
        clean({ tls: { ...clean().tls!, certificate } }),
        window === undefined ? undefined : { certExpiryWarnDays: window }
      )
      expect(one(r.items, 'tls.certificate-expiring')?.evidence).toEqual(
        expected ? { daysLeft: expected } : undefined
      )
    }
  )
})

describe('headers (CA-11..CA-14)', () => {
  it.each([
    [undefined, 'headers.hsts-missing'],
    ['includeSubDomains', 'headers.hsts-missing'],
    ['max-age=86400', 'headers.hsts-short-max-age'],
    ['max-age=15551999', 'headers.hsts-short-max-age'],
    ['max-age=15552000', undefined]
  ])('Strict-Transport-Security %s → %s', (value, expected) => {
    const r = run(withHeaders({ 'strict-transport-security': value }))
    expect(ids(r.items).filter((i) => i.startsWith('headers.hsts'))).toEqual(
      expected ? [expected] : []
    )
  })

  it('reports the short max-age value', () => {
    const r = run(withHeaders({ 'strict-transport-security': 'max-age=86400' }))
    expect(one(r.items, 'headers.hsts-short-max-age')?.evidence).toEqual({ maxAge: '86400' })
  })

  it('HSTS rules neither fire nor count for an IP-literal host', () => {
    const url = 'https://203.0.113.5/x'
    const r = run(withHeaders({ 'strict-transport-security': undefined }, { finalUrl: url }))
    expect(ids(r.items)).toEqual([])
    expect(r.rulesApplied).toBe(15)
  })

  it('nosniff applies only to a response with a body', () => {
    const noHeader = { 'x-content-type-options': undefined }
    expect(ids(run(withHeaders(noHeader)).items)).toEqual(['headers.nosniff-missing'])
    const empty = withHeaders(noHeader)
    expect(run({ ...empty, response: { ...empty.response, hasBody: false } }).items).toEqual([])
    expect(ids(run(withHeaders({ 'x-content-type-options': 'sniff' })).items)).toEqual([
      'headers.nosniff-missing'
    ])
  })

  it('CSP and frame protection apply to text/html only', () => {
    expect(run(withHeaders({ 'content-type': 'application/json' })).items).toEqual([])
    const html = run(withHeaders({ 'content-type': 'text/html; charset=utf-8' }))
    expect(ids(html.items)).toEqual(['headers.csp-missing', 'headers.frame-protection-missing'])
  })

  it.each([
    [{ 'content-security-policy': "frame-ancestors 'none'" }, []],
    [{ 'x-frame-options': 'DENY' }, ['headers.csp-missing']],
    [
      { 'content-security-policy-report-only': "default-src 'self'" },
      ['headers.csp-missing', 'headers.frame-protection-missing']
    ]
  ])('HTML with %o fires %j', (headers, expected) => {
    const r = run(withHeaders({ 'content-type': 'text/html', ...headers }))
    expect(ids(r.items)).toEqual(expected)
  })

  it('wildcard CORS with credentials', () => {
    const r = run(
      withHeaders({
        'access-control-allow-origin': '*',
        'access-control-allow-credentials': 'true'
      })
    )
    expect(ids(r.items)).toEqual(['headers.cors-wildcard-credentials'])
    expect(run(withHeaders({ 'access-control-allow-origin': '*' })).items).toEqual([])
  })

  it('a reflected origin with credentials, only when the request sent an Origin', () => {
    const headers = {
      'access-control-allow-origin': 'https://app.example',
      'access-control-allow-credentials': 'TRUE'
    }
    const withOrigin = run(
      withHeaders(headers, { requestHeaders: [['Origin', 'https://APP.example']] })
    )
    expect(ids(withOrigin.items)).toEqual(['headers.cors-reflected-origin'])
    const without = run(withHeaders(headers))
    expect(without.items).toEqual([])
    expect(withOrigin.rulesApplied - without.rulesApplied).toBe(1)
  })

  it.each([
    [{ server: 'nginx/1.25.3' }, ['Server']],
    [{ server: 'Apache 2.4' }, ['Server']],
    [{ server: 'nginx' }, []],
    [{ server: 'cloudflare' }, []],
    [{ 'x-powered-by': 'PHP/8.2.1' }, ['X-Powered-By']],
    [{ 'x-aspnet-version': '4.0.30319' }, ['X-AspNet-Version']],
    [{ 'X-AspNetMvc-Version': '5.2' }, ['X-AspNetMvc-Version']]
  ])('version disclosure in %o names %j', (headers, expected) => {
    const r = run(withHeaders(headers))
    expect(
      r.items.filter((f) => f.ruleId === 'headers.version-disclosure').map((f) => f.evidence.header)
    ).toEqual(expected)
  })
})

describe('cookies (CA-15, CA-16)', () => {
  const hops = (...list: Array<[string, string[]]>): Partial<FindingsExchange> => ({
    hops: list.map(([url, setCookie]) => ({ url, setCookie })),
    finalUrl: list[list.length - 1][0]
  })

  it('evaluates every hop’s cookies, each against its own hop, naming cookie and hop', () => {
    const r = run(
      clean(
        hops(
          ['https://login.example/auth', ['sid=SENTINEL; Path=/']],
          ['https://api.example/home', []]
        )
      )
    )
    expect(r.items.filter((f) => f.category === 'cookies')).toEqual([
      {
        ruleId: 'cookies.missing-secure',
        severity: 'medium',
        category: 'cookies',
        evidence: { cookie: 'sid', hop: 'https://login.example' }
      },
      {
        ruleId: 'cookies.missing-httponly',
        severity: 'low',
        category: 'cookies',
        evidence: { cookie: 'sid', hop: 'https://login.example' }
      }
    ])
  })

  it('missing-secure applies to https hops only; deletions fire nothing', () => {
    const r = run(
      clean(
        hops(
          ['http://plain.example/a', ['pref=1; HttpOnly']],
          ['https://api.example/b', ['sid=; Max-Age=0']]
        )
      )
    )
    expect(r.items.filter((f) => f.category === 'cookies')).toEqual([])
  })

  it('a secure, HTTP-only cookie fires nothing; counts both cookie rules and the cacheable-cookie rule', () => {
    const r = run(clean(hops(['https://api.example/b', ['sid=1; Secure; HttpOnly']])))
    expect(r.items).toEqual([])
    expect(r.rulesApplied).toBe(20)
  })
})

describe('auth and cache (CA-17, CA-18)', () => {
  it('flags credential parameter names, whole names only, once each', () => {
    const url =
      'https://api.example/x?api-key=SENTINEL&Access_Token=SENTINEL&sort_key=1&monkey=2&api-key=3'
    const r = run(clean({ finalUrl: url, hops: [{ url, setCookie: [] }] }))
    expect(
      r.items.filter((f) => f.ruleId === 'auth.credentials-in-query').map((f) => f.evidence)
    ).toEqual([{ parameter: 'api-key' }, { parameter: 'Access_Token' }])
  })

  it('flags the API-key scheme’s own query parameter whatever its name', () => {
    const url = 'https://api.example/x?subscription=SENTINEL'
    const r = run(
      clean({
        finalUrl: url,
        hops: [{ url, setCookie: [] }],
        auth: { type: 'api-key', key: 'subscription', value: '', location: 'query' }
      })
    )
    expect(one(r.items, 'auth.credentials-in-query')?.evidence).toEqual({
      parameter: 'subscription'
    })
  })

  it.each([
    ['max-age=60', true],
    ['private', false],
    ['private="set-cookie"', false],
    ['no-store', false],
    [undefined, true]
  ])('credentials + Cache-Control %s → sensitive-cacheable %s', (cc, fires) => {
    const r = run(
      withHeaders({ 'cache-control': cc }, { requestHeaders: [['Authorization', 'Bearer x']] })
    )
    expect(ids(r.items).includes('cache.sensitive-cacheable')).toBe(fires)
  })

  it('sensitive-cacheable neither fires nor counts without credentials', () => {
    const r = run(withHeaders({ 'cache-control': undefined }))
    expect(r.items).toEqual([])
    expect(r.rulesApplied).toBe(17)
  })
})

describe('downgrade, forward secrecy, cacheable cookies, null origin', () => {
  const chain = (...urls: string[]): Partial<FindingsExchange> => ({
    hops: urls.map((url) => ({ url, setCookie: [] })),
    finalUrl: urls[urls.length - 1],
    ...(urls[urls.length - 1].startsWith('http:') ? { tls: undefined } : {})
  })

  it('a redirect that drops to plain HTTP: downgrade once, from/to origins, plaintext too (CA-01)', () => {
    const r = run(clean(chain('https://login.example/auth', 'http://app.example/home')))
    expect(r.items.filter((f) => f.ruleId === 'transport.https-downgrade')).toEqual([
      {
        ruleId: 'transport.https-downgrade',
        severity: 'high',
        category: 'transport',
        evidence: { from: 'https://login.example', to: 'http://app.example' }
      }
    ])
    expect(ids(r.items)).toContain('transport.plaintext')
  })

  it('a downgrade in the middle of a chain fires once and leaves plaintext out (CA-02)', () => {
    const r = run(clean(chain('https://a.example/1', 'http://b.example/2', 'https://c.example/3')))
    expect(
      r.items.filter((f) => f.ruleId === 'transport.https-downgrade').map((f) => f.evidence)
    ).toEqual([{ from: 'https://a.example', to: 'http://b.example' }])
    expect(ids(r.items)).not.toContain('transport.plaintext')
  })

  it('reports each transition of a chain that drops twice', () => {
    const r = run(
      clean(
        chain('https://a.example/', 'http://b.example/', 'https://c.example/', 'http://d.example/')
      )
    )
    expect(r.items.filter((f) => f.ruleId === 'transport.https-downgrade')).toHaveLength(2)
  })

  it.each([
    ['a single hop', ['https://api.example/x'], false],
    ['an all-http chain', ['http://a.example/', 'http://b.example/'], false],
    ['an all-https chain', ['https://a.example/', 'https://b.example/'], true],
    ['https then loopback http', ['https://a.example/', 'http://localhost:3000/'], true],
    ['https then 127.0.0.1', ['https://a.example/', 'http://127.0.0.1/'], true]
  ])('downgrade on %s: never fires; counted as applied: %s (CA-03)', (_l, urls, applied) => {
    const ex = clean(chain(...urls))
    const on = run(ex)
    const off = run(ex, { disabledRules: ['transport.https-downgrade'] })
    expect(ids(on.items)).not.toContain('transport.https-downgrade')
    expect(on.rulesApplied - off.rulesApplied).toBe(applied ? 1 : 0)
  })

  it.each([
    ['TLSv1.2', 'AES128-GCM-SHA256', true],
    ['TLSv1.2', 'TLS_RSA_WITH_AES_256_GCM_SHA384', true],
    ['TLSv1.2', 'ECDHE-RSA-AES128-GCM-SHA256', false],
    ['TLSv1.2', 'DHE-RSA-AES256-GCM-SHA384', false],
    ['TLSv1.2', 'EDH-RSA-DES-CBC3-SHA', false],
    ['TLSv1.3', 'TLS_AES_128_GCM_SHA256', false]
  ])('%s %s lacks forward secrecy: %s (CA-04)', (protocol, cipher, fires) => {
    const r = run(clean({ tls: { ...clean().tls!, protocol, cipher } }))
    expect(one(r.items, 'tls.no-forward-secrecy')?.evidence).toEqual(fires ? { cipher } : undefined)
  })

  it('forward secrecy is independent of the version and cipher-mode rules (CA-05)', () => {
    const r = run(clean({ tls: { ...clean().tls!, protocol: 'TLSv1.1', cipher: 'AES128-SHA' } }))
    expect(ids(r.items)).toEqual(
      expect.arrayContaining([
        'tls.legacy-protocol',
        'tls.non-aead-cipher',
        'tls.no-forward-secrecy'
      ])
    )
  })

  describe('cacheable response that sets a cookie (CA-06, CA-07)', () => {
    const tomorrow = new Date(NOW.getTime() + DAY).toUTCString()
    const setting = (
      caching: Record<string, string | undefined>,
      cookies = ['sid=1; Secure; HttpOnly', 'theme=dark; Secure; HttpOnly']
    ): FindingsExchange =>
      withHeaders(
        { 'cache-control': undefined, ...caching },
        { hops: [{ url: 'https://api.example/resource', setCookie: cookies }] }
      )

    it.each([
      [{ 'cache-control': 'public' }, true],
      [{ 'cache-control': 'max-age=600' }, true],
      [{ 'cache-control': 's-maxage=60' }, true],
      [{ expires: tomorrow }, true],
      [{ 'cache-control': 'public, private' }, false],
      [{ 'cache-control': 'max-age=600, no-store' }, false],
      [{ 'cache-control': 'no-cache="Set-Cookie", max-age=600' }, false],
      [{ 'cache-control': 'max-age=0' }, false],
      [{}, false]
    ])('caching %o → fires %s, naming every cookie', (caching, fires) => {
      const r = run(setting(caching))
      expect(one(r.items, 'cache.set-cookie-cacheable')).toEqual(
        fires
          ? {
              ruleId: 'cache.set-cookie-cacheable',
              severity: 'medium',
              category: 'cache',
              evidence: { cookies: 'sid, theme' }
            }
          : undefined
      )
    })

    it.each([
      ['sets no cookie', [] as string[]],
      ['only deletes one', ['sid=; Max-Age=0']]
    ])('a cacheable response that %s: neither fires nor counts', (_l, cookies) => {
      const ex = setting({ 'cache-control': 'public' }, cookies)
      const on = run(ex)
      const off = run(ex, { disabledRules: ['cache.set-cookie-cacheable'] })
      expect(ids(on.items)).not.toContain('cache.set-cookie-cacheable')
      expect(on.rulesApplied).toBe(off.rulesApplied)
    })

    it('reads only the final response’s cookies, not an earlier hop’s', () => {
      const r = run(
        withHeaders(
          { 'cache-control': 'public' },
          {
            hops: [
              { url: 'https://login.example/a', setCookie: ['sid=1; Secure; HttpOnly'] },
              { url: 'https://api.example/b', setCookie: [] }
            ]
          }
        )
      )
      expect(ids(r.items)).not.toContain('cache.set-cookie-cacheable')
    })

    it('coexists with sensitive-cacheable when the request carried credentials', () => {
      const ex = setting({ 'cache-control': 'max-age=600' })
      const r = run({ ...ex, requestHeaders: [['Authorization', 'Bearer x']] })
      expect(ids(r.items)).toEqual(
        expect.arrayContaining(['cache.set-cookie-cacheable', 'cache.sensitive-cacheable'])
      )
    })
  })

  it.each([
    ['null', true],
    [' NULL ', true],
    ['*', false],
    ['https://app.example', false]
  ])(
    'Access-Control-Allow-Origin %j → null-origin fires %s, always counted (CA-08)',
    (acao, fires) => {
      const ex = withHeaders({ 'access-control-allow-origin': acao })
      const on = run(ex)
      const off = run(ex, { disabledRules: ['headers.cors-null-origin'] })
      expect(ids(on.items).includes('headers.cors-null-origin')).toBe(fires)
      expect(on.rulesApplied - off.rulesApplied).toBe(1)
    }
  )
})

describe('settings, ordering, counting and masking (CA-19, CA-20, CA-22)', () => {
  it('a disabled rule neither fires nor counts', () => {
    const ex = withHeaders({ server: 'nginx/1.25.3' })
    const on = run(ex)
    const off = run(ex, { disabledRules: ['headers.version-disclosure'] })
    expect(ids(on.items)).toEqual(['headers.version-disclosure'])
    expect(off.items).toEqual([])
    expect(on.rulesApplied - off.rulesApplied).toBe(1)
  })

  it('orders by severity, then rule id', () => {
    const r = run(
      withHeaders(
        {
          'strict-transport-security': undefined,
          server: 'nginx/1.2',
          'x-content-type-options': undefined
        },
        { verifySsl: false }
      )
    )
    expect(ids(r.items)).toEqual([
      'headers.hsts-missing',
      'tls.verification-disabled',
      'headers.nosniff-missing',
      'headers.version-disclosure'
    ])
  })

  it('counts the four rules of a loopback 204 with no credentials, cookies or Origin', () => {
    const url = 'http://localhost:8080/ping'
    const r = run({
      finalUrl: url,
      requestHeaders: [],
      response: { headers: {}, hasBody: false },
      hops: [{ url, setCookie: [] }],
      verifySsl: true
    })
    expect(r.items).toEqual([])
    // cors-wildcard, cors-null, version-disclosure, credentials-in-query.
    expect(r.rulesApplied).toBe(4)
  })

  it('reports the final origin, never the URL’s path or query', () => {
    const url = 'https://api.example:8443/p?token=SENTINEL'
    expect(run(clean({ finalUrl: url, hops: [{ url, setCookie: [] }] })).finalOrigin).toBe(
      'https://api.example:8443'
    )
  })

  it('no value ever reaches the evaluation output', () => {
    const SENTINEL = 'SENTINEL-7f3a'
    const headers: Array<[string, string]> = [
      ['Authorization', `Bearer ${SENTINEL}`],
      ['Cookie', `sid=${SENTINEL}`],
      ['Origin', `https://${SENTINEL}.example`],
      ['X-Api-Key', SENTINEL]
    ]
    const cookies = [`sid=${SENTINEL}`, `${'tok'}=${SENTINEL}; Max-Age=60`]
    const query = `?token=${SENTINEL}&api_key=${SENTINEL}&password=${SENTINEL}`
    const responseHeaders = {
      'access-control-allow-origin': `https://${SENTINEL}.example`,
      'access-control-allow-credentials': 'true',
      server: `nginx/1.2 ${SENTINEL}`,
      'content-type': 'text/html',
      'cache-control': `max-age=${SENTINEL}`
    }
    const auth = {
      type: 'api-key' as const,
      key: 'X-Api-Key',
      value: SENTINEL,
      location: 'header' as const
    }
    const expiredTls = {
      protocol: 'TLSv1',
      cipher: 'AES128-SHA',
      authorized: false,
      authorizationError: 'DEPTH_ZERO_SELF_SIGNED_CERT',
      certificate: { validTo: new Date(NOW.getTime() - DAY), keyType: 'rsa', bits: 1024 }
    }
    for (const base of ['https://api.example/x', 'http://api.example/x']) {
      const url = base + query
      const r = run({
        finalUrl: url,
        requestHeaders: headers,
        response: { headers: responseHeaders, hasBody: true },
        hops: [{ url, setCookie: cookies }],
        tls: base.startsWith('https') ? expiredTls : undefined,
        verifySsl: false,
        auth
      })
      expect(r.items.length).toBeGreaterThan(5)
      expect(JSON.stringify(r)).not.toContain(SENTINEL)
    }
  })
})
