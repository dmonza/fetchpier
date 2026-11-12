import { describe, it, expect } from 'vitest'
import { applyAuth } from './auth'
import type { HttpRequest, AuthConfig } from '@shared/types'

const baseRequest: HttpRequest = {
  method: 'GET',
  url: 'https://api.example.com/data',
  headers: {}
}

describe('applyAuth', () => {
  it('returns the request unchanged when auth is undefined', () => {
    const result = applyAuth(baseRequest, undefined)
    expect(result).toEqual(baseRequest)
  })

  it('returns the request unchanged when auth type is none', () => {
    const auth: AuthConfig = { type: 'none' }
    const result = applyAuth(baseRequest, auth)
    expect(result).toEqual(baseRequest)
  })

  describe('Bearer Token', () => {
    it('adds Authorization header with bearer token', () => {
      const auth: AuthConfig = { type: 'bearer', token: 'my-secret-token' }
      const result = applyAuth(baseRequest, auth)
      expect(result.headers['Authorization']).toBe('Bearer my-secret-token')
    })

    it('does not add Authorization header when token is empty', () => {
      const auth: AuthConfig = { type: 'bearer', token: '' }
      const result = applyAuth(baseRequest, auth)
      expect(result.headers['Authorization']).toBeUndefined()
    })

    it('does not mutate the original request headers', () => {
      const auth: AuthConfig = { type: 'bearer', token: 'token' }
      applyAuth(baseRequest, auth)
      expect(baseRequest.headers['Authorization']).toBeUndefined()
    })
  })

  describe('Basic Auth', () => {
    it('adds Authorization header with base64-encoded credentials', () => {
      const auth: AuthConfig = { type: 'basic', username: 'user', password: 'pass' }
      const result = applyAuth(baseRequest, auth)
      const expected = `Basic ${Buffer.from('user:pass').toString('base64')}`
      expect(result.headers['Authorization']).toBe(expected)
    })

    it('encodes correctly when password contains special characters', () => {
      const auth: AuthConfig = { type: 'basic', username: 'admin', password: 'p@$$w0rd!' }
      const result = applyAuth(baseRequest, auth)
      const expected = `Basic ${Buffer.from('admin:p@$$w0rd!').toString('base64')}`
      expect(result.headers['Authorization']).toBe(expected)
    })

    it('handles empty password', () => {
      const auth: AuthConfig = { type: 'basic', username: 'user', password: '' }
      const result = applyAuth(baseRequest, auth)
      const expected = `Basic ${Buffer.from('user:').toString('base64')}`
      expect(result.headers['Authorization']).toBe(expected)
    })

    it('does not add Authorization header when both username and password are empty', () => {
      const auth: AuthConfig = { type: 'basic', username: '', password: '' }
      const result = applyAuth(baseRequest, auth)
      expect(result.headers['Authorization']).toBeUndefined()
    })
  })

  describe('API Key — header location', () => {
    it('adds custom header with the given key and value', () => {
      const auth: AuthConfig = {
        type: 'api-key',
        key: 'X-API-Key',
        value: 'abc123',
        location: 'header'
      }
      const result = applyAuth(baseRequest, auth)
      expect(result.headers['X-API-Key']).toBe('abc123')
    })

    it('does not modify URL when location is header', () => {
      const auth: AuthConfig = {
        type: 'api-key',
        key: 'X-API-Key',
        value: 'abc123',
        location: 'header'
      }
      const result = applyAuth(baseRequest, auth)
      expect(result.url).toBe(baseRequest.url)
    })

    it('does not add header when key is empty', () => {
      const auth: AuthConfig = { type: 'api-key', key: '', value: 'abc123', location: 'header' }
      const result = applyAuth(baseRequest, auth)
      expect(Object.keys(result.headers)).toHaveLength(0)
    })
  })

  describe('API Key — query location', () => {
    it('appends key=value as query parameter when URL has no existing params', () => {
      const auth: AuthConfig = {
        type: 'api-key',
        key: 'api_key',
        value: 'secret',
        location: 'query'
      }
      const result = applyAuth(baseRequest, auth)
      expect(result.url).toBe('https://api.example.com/data?api_key=secret')
    })

    it('appends key=value with & when URL already has query params', () => {
      const reqWithParams: HttpRequest = {
        ...baseRequest,
        url: 'https://api.example.com/data?page=1'
      }
      const auth: AuthConfig = {
        type: 'api-key',
        key: 'api_key',
        value: 'secret',
        location: 'query'
      }
      const result = applyAuth(reqWithParams, auth)
      expect(result.url).toBe('https://api.example.com/data?page=1&api_key=secret')
    })

    it('URL-encodes key and value', () => {
      const auth: AuthConfig = {
        type: 'api-key',
        key: 'my key',
        value: 'val/ue',
        location: 'query'
      }
      const result = applyAuth(baseRequest, auth)
      expect(result.url).toBe('https://api.example.com/data?my%20key=val%2Fue')
    })

    it('does not modify headers when location is query', () => {
      const auth: AuthConfig = {
        type: 'api-key',
        key: 'api_key',
        value: 'secret',
        location: 'query'
      }
      const result = applyAuth(baseRequest, auth)
      expect(Object.keys(result.headers)).toHaveLength(0)
    })

    it('does not add query param when key is empty', () => {
      const auth: AuthConfig = { type: 'api-key', key: '', value: 'secret', location: 'query' }
      const result = applyAuth(baseRequest, auth)
      expect(result.url).toBe(baseRequest.url)
    })
  })

  it('preserves existing headers when adding auth', () => {
    const reqWithHeaders: HttpRequest = {
      ...baseRequest,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' }
    }
    const auth: AuthConfig = { type: 'bearer', token: 'token123' }
    const result = applyAuth(reqWithHeaders, auth)
    expect(result.headers['Content-Type']).toBe('application/json')
    expect(result.headers['Accept']).toBe('application/json')
    expect(result.headers['Authorization']).toBe('Bearer token123')
  })

  // REQ §6.4: a managed scheme owns its header name — auth reconciliation strips
  // every same-name entry (including duplicates) and re-materializes one value.
  describe('headerList (ordered, duplicate-capable)', () => {
    it('replaces every same-name entry with the managed value', () => {
      const req: HttpRequest = {
        ...baseRequest,
        headers: { Authorization: 'stale' },
        headerList: [
          { name: 'Authorization', value: 'stale-a' },
          { name: 'Accept', value: 'application/json' },
          { name: 'authorization', value: 'stale-b' }
        ]
      }
      const result = applyAuth(req, { type: 'bearer', token: 't' })
      const auths = result.headerList!.filter((h) => h.name.toLowerCase() === 'authorization')
      expect(auths).toEqual([{ name: 'Authorization', value: 'Bearer t' }])
      // Non-managed entries are untouched.
      expect(result.headerList!.some((h) => h.name === 'Accept')).toBe(true)
    })

    // ENG-30: the record feeds the request snapshot (and, with no list, the
    // wire), so a case variant left there reports a credential never sent.
    it.each<[string, AuthConfig, string, string]>([
      ['bearer', { type: 'bearer', token: 'abc' }, 'authorization', 'Authorization'],
      ['basic', { type: 'basic', username: 'u', password: 'p' }, 'AUTHORIZATION', 'Authorization'],
      [
        'api-key',
        { type: 'api-key', key: 'X-Api-Key', value: 'k', location: 'header' },
        'x-api-key',
        'X-Api-Key'
      ]
    ])(
      'removes a case-variant record key for a %s managed header',
      (_l, auth, variant, managed) => {
        const req: HttpRequest = {
          ...baseRequest,
          headers: { [variant]: 'from-script', Accept: 'application/json' },
          headerList: [
            { name: variant, value: 'from-script' },
            { name: 'Accept', value: 'application/json' }
          ]
        }
        const result = applyAuth(req, auth)
        expect(
          Object.keys(result.headers).filter((k) => k.toLowerCase() === managed.toLowerCase())
        ).toEqual([managed])
        expect(result.headers.Accept).toBe('application/json')
      }
    )

    it('removes a case-variant record key when the request has no header list', () => {
      const req: HttpRequest = { ...baseRequest, headers: { authorization: 'Bearer stale' } }
      const result = applyAuth(req, { type: 'bearer', token: 'abc' })
      expect(result.headers).toEqual({ Authorization: 'Bearer abc' })
    })

    it('preserves unrelated duplicate headers', () => {
      const req: HttpRequest = {
        ...baseRequest,
        headers: { Accept: 'text/html' },
        headerList: [
          { name: 'Accept', value: 'application/json' },
          { name: 'Accept', value: 'text/html' }
        ]
      }
      const result = applyAuth(req, { type: 'bearer', token: 't' })
      expect(result.headerList!.filter((h) => h.name === 'Accept').map((h) => h.value)).toEqual([
        'application/json',
        'text/html'
      ])
    })
  })
})
