import { describe, expect, it } from 'vitest'
import { CoreError } from '../shared/context'
import { matchesNoProxy, resolveProxyRouting } from './proxy-env'

const HTTPS = 'https://api.example.com/users'
const HTTP = 'http://api.example.com/users'

describe('resolveProxyRouting', () => {
  it('returns no routing when nothing is configured', () => {
    const r = resolveProxyRouting({ env: {} })
    expect(r.active).toBeUndefined()
    expect(r.proxyFor(HTTPS)).toBeUndefined()
  })

  it('selects HTTPS_PROXY for https targets and HTTP_PROXY for http targets', () => {
    const r = resolveProxyRouting({
      env: { HTTPS_PROXY: 'http://secure-proxy:3128', HTTP_PROXY: 'http://plain-proxy:3128' }
    })
    expect(r.proxyFor(HTTPS)?.url).toBe('http://secure-proxy:3128')
    expect(r.proxyFor(HTTP)?.url).toBe('http://plain-proxy:3128')
  })

  it('accepts the lowercase variables, uppercase winning when both are set', () => {
    expect(resolveProxyRouting({ env: { https_proxy: 'http://p:1' } }).proxyFor(HTTPS)?.url).toBe(
      'http://p:1'
    )
    expect(
      resolveProxyRouting({
        env: { HTTPS_PROXY: 'http://upper:1', https_proxy: 'http://lower:1' }
      }).proxyFor(HTTPS)?.url
    ).toBe('http://upper:1')
  })

  it('ignores empty or whitespace-only values', () => {
    expect(resolveProxyRouting({ env: { HTTPS_PROXY: '  ' } }).proxyFor(HTTPS)).toBeUndefined()
  })

  it('the flag wins over the variables and applies to every scheme', () => {
    const r = resolveProxyRouting({
      flag: 'http://flag-proxy:8080',
      env: { HTTPS_PROXY: 'http://env-proxy:3128' }
    })
    expect(r.proxyFor(HTTPS)?.url).toBe('http://flag-proxy:8080')
    expect(r.proxyFor(HTTP)?.url).toBe('http://flag-proxy:8080')
    expect(r.active?.source).toBe('--proxy')
  })

  it('splits URL credentials into username/password and strips them from the url', () => {
    const p = resolveProxyRouting({ flag: 'http://user:p%40ss@proxy:3128' }).proxyFor(HTTPS)
    expect(p).toEqual({
      enabled: true,
      url: 'http://proxy:3128',
      username: 'user',
      password: 'p@ss'
    })
  })

  it('describes the active proxy without credentials, naming its source', () => {
    const r = resolveProxyRouting({ env: { HTTPS_PROXY: 'http://user:secret@proxy:3128' } })
    expect(r.active).toEqual({ display: 'http://proxy:3128', source: 'HTTPS_PROXY' })
    expect(JSON.stringify(r.active)).not.toContain('secret')
  })

  it('NO_PROXY excludes targets from the flag and from the variables', () => {
    const env = { HTTPS_PROXY: 'http://p:1', NO_PROXY: 'api.example.com' }
    expect(resolveProxyRouting({ env }).proxyFor(HTTPS)).toBeUndefined()
    expect(resolveProxyRouting({ flag: 'http://f:1', env }).proxyFor(HTTPS)).toBeUndefined()
  })

  it('the description carries the exclusion list when there is one', () => {
    expect(
      resolveProxyRouting({ env: { HTTPS_PROXY: 'http://p:1', NO_PROXY: '.internal.test' } }).active
    ).toEqual({ display: 'http://p:1', source: 'HTTPS_PROXY', noProxy: '.internal.test' })
    expect(resolveProxyRouting({ env: { HTTPS_PROXY: 'http://p:1' } }).active).not.toHaveProperty(
      'noProxy'
    )
  })

  it('noProxy ignores all three variables', () => {
    const r = resolveProxyRouting({ noProxy: true, env: { HTTPS_PROXY: 'http://p:1' } })
    expect(r.proxyFor(HTTPS)).toBeUndefined()
    expect(r.active).toBeUndefined()
  })

  it.each([
    ['flag', { flag: 'not a url' }, '--proxy'],
    ['variable', { env: { HTTPS_PROXY: 'not a url' } }, 'HTTPS_PROXY'],
    ['unsupported scheme', { flag: 'ftp://proxy:21' }, '--proxy']
  ])('an invalid %s is rejected naming its source', (_label, input, source) => {
    let err: unknown
    try {
      resolveProxyRouting(input)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(CoreError)
    expect((err as CoreError).code).toBe('PROXY_INVALID')
    expect((err as CoreError).message).toContain(source)
  })

  it('rejects the flag together with noProxy', () => {
    expect(() => resolveProxyRouting({ flag: 'http://p:1', noProxy: true })).toThrow(CoreError)
  })
})

describe('matchesNoProxy', () => {
  it.each([
    ['api.example.com', 'https://api.example.com/x', true],
    ['API.Example.com', 'https://api.example.com/x', true],
    ['example.com', 'https://api.example.com/x', true],
    ['.example.com', 'https://api.example.com/x', true],
    ['.example.com', 'https://example.com/x', true],
    ['example.com', 'https://notexample.com/x', false],
    ['api.example.com:8443', 'https://api.example.com:8443/x', true],
    ['api.example.com:8443', 'https://api.example.com/x', false],
    ['*', 'https://anything.test/x', true],
    ['localhost, 127.0.0.1', 'http://127.0.0.1:9200/x', true],
    ['', 'https://api.example.com/x', false]
  ])('NO_PROXY=%j against %s → %s', (list, url, expected) => {
    expect(matchesNoProxy(url, list)).toBe(expected)
  })
})
