import { describe, it, expect } from 'vitest'
import { authEcho } from './auth-echo'
import type { AuthConfig } from '../types'

describe('authEcho', () => {
  it('none → no echo', () => {
    expect(authEcho({ type: 'none' })).toEqual({})
    expect(authEcho(undefined)).toEqual({})
    expect(authEcho(null)).toEqual({})
  })

  it('bearer → Authorization header, token verbatim', () => {
    expect(authEcho({ type: 'bearer', token: '{{token}}' })).toEqual({
      header: { name: 'Authorization', value: 'Bearer {{token}}' }
    })
  })

  it('bearer with empty token → no echo', () => {
    expect(authEcho({ type: 'bearer', token: '   ' })).toEqual({})
  })

  it('basic → unencoded Authorization header (encoding happens at send time)', () => {
    expect(authEcho({ type: 'basic', username: '{{user}}', password: '{{pass}}' })).toEqual({
      header: { name: 'Authorization', value: 'Basic {{user}}:{{pass}}' }
    })
  })

  it('basic with one empty field is still echoed (REQ §10 Q3)', () => {
    expect(authEcho({ type: 'basic', username: 'u', password: '' })).toEqual({
      header: { name: 'Authorization', value: 'Basic u:' }
    })
  })

  it('basic with both empty → no echo (block still carries the scheme)', () => {
    expect(authEcho({ type: 'basic', username: '', password: '' })).toEqual({})
  })

  it('api-key header → custom header', () => {
    const auth: AuthConfig = {
      type: 'api-key',
      key: 'X-API-Key',
      value: '{{apiKey}}',
      location: 'header'
    }
    expect(authEcho(auth)).toEqual({ header: { name: 'X-API-Key', value: '{{apiKey}}' } })
  })

  it('api-key query → query parameter', () => {
    const auth: AuthConfig = {
      type: 'api-key',
      key: 'api_key',
      value: '{{apiKey}}',
      location: 'query'
    }
    expect(authEcho(auth)).toEqual({ query: { key: 'api_key', value: '{{apiKey}}' } })
  })

  it('api-key with empty key → no echo', () => {
    expect(authEcho({ type: 'api-key', key: '', value: 'x', location: 'header' })).toEqual({})
  })
})
