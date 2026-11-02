import { describe, it, expect, vi } from 'vitest'
import { parseHttpFile } from './parser'
import { applyAuth } from './auth'
import { serializeRequest, splitUrlAndParams } from '@shared/lib/http-serializer'
import { DEFAULT_REQUEST_STATE } from '@shared/types'
import type { AuthConfig, HttpRequest, KeyValuePair, RequestEditorState } from '@shared/types'

/**
 * REQ-0083 — end-to-end persistence of the auth scheme through the shared
 * parser + serializer (both consumed by the desktop and the CLI runner).
 */

function state(overrides: Partial<RequestEditorState>): RequestEditorState {
  return { ...DEFAULT_REQUEST_STATE, ...overrides }
}

/** Reconstructs the editor state a reopened request would carry (mirrors the
 * renderer's request-loader for the fields under test) so we can re-serialize
 * and assert byte-stability across a save → reopen → save cycle. */
function reopen(parsed: HttpRequest): RequestEditorState {
  const { baseUrl, params } = splitUrlAndParams(parsed.url)
  let id = 0
  const headers: KeyValuePair[] = Object.entries(parsed.headers).map(([key, value]) => ({
    id: `h-${id++}`,
    key,
    value,
    enabled: true
  }))
  return state({
    method: parsed.method,
    url: baseUrl,
    params,
    headers,
    auth: parsed.auth ?? { type: 'none' }
  })
}

const SCHEMES: AuthConfig[] = [
  { type: 'bearer', token: '{{token}}' },
  { type: 'basic', username: '{{user}}', password: '{{pass}}' },
  { type: 'api-key', key: 'X-API-Key', value: '{{apiKey}}', location: 'header' },
  { type: 'api-key', key: 'api_key', value: '{{apiKey}}', location: 'query' }
]

describe('REQ-0083 auth round-trip', () => {
  it.each(SCHEMES)(
    'restores the scheme and strips the echo from the editable set ($type)',
    (auth) => {
      const params: KeyValuePair[] =
        auth.type === 'api-key' && auth.location === 'query'
          ? [{ id: 'p1', key: 'page', value: '1', enabled: true }]
          : []
      const text = serializeRequest(
        state({ method: 'GET', url: 'https://api.example.com/users', params, auth })
      )
      const parsed = parseHttpFile(text).requests[0]

      // The scheme is restored verbatim (tokens unresolved).
      expect(parsed.auth).toEqual(auth)

      // The echo is no longer part of the editable header / parameter set.
      if (auth.type === 'api-key' && auth.location === 'query') {
        expect(parsed.url).not.toContain('api_key=')
        expect(parsed.url).toContain('page=1')
      } else {
        const echoName = auth.type === 'api-key' ? 'X-API-Key' : 'Authorization'
        expect(Object.keys(parsed.headers)).not.toContain(echoName)
      }
    }
  )

  it.each(SCHEMES)('re-save after reopen is byte-identical ($type)', (auth) => {
    const params: KeyValuePair[] =
      auth.type === 'api-key' && auth.location === 'query'
        ? [{ id: 'p1', key: 'page', value: '1', enabled: true }]
        : []
    const first = serializeRequest(
      state({ method: 'GET', url: 'https://api.example.com/users', params, auth })
    )
    const second = serializeRequest(reopen(parseHttpFile(first).requests[0]))
    expect(second).toBe(first)
  })

  it('the @auth block is comment-prefixed and the echo is a standard header (§9.2)', () => {
    const text = serializeRequest(
      state({ url: 'https://api.example.com', auth: { type: 'bearer', token: '{{token}}' } })
    )
    expect(text).toContain('# @auth')
    expect(text).toContain('# type: bearer')
    expect(text).toContain('# token: {{token}}')
    expect(text).toContain('# @end-auth')
    expect(text).toContain('Authorization: Bearer {{token}}')
    // Basic echo is NOT base64-encoded on disk (§5.2).
  })

  it('basic echo is written unencoded (§5.2)', () => {
    const text = serializeRequest(
      state({ url: 'https://x', auth: { type: 'basic', username: 'u', password: 'p' } })
    )
    expect(text).toContain('Authorization: Basic u:p')
  })

  it('none writes neither block nor echo (CA-03)', () => {
    const text = serializeRequest(state({ url: 'https://api.example.com', auth: { type: 'none' } }))
    expect(text).not.toContain('@auth')
    expect(text).not.toContain('Authorization')
    expect(parseHttpFile(text).requests[0].auth).toBeUndefined()
  })

  it('a hand-authored auth header without a block stays manual (CA-02)', () => {
    const text = 'GET https://api.example.com\nAuthorization: Bearer hardcoded\n'
    const parsed = parseHttpFile(text).requests[0]
    expect(parsed.auth).toBeUndefined()
    expect(parsed.headers['Authorization']).toBe('Bearer hardcoded')
  })

  it('external divergence — block wins, same-name manual header is dropped (CA-05)', () => {
    const text =
      '# @auth\n# type: bearer\n# token: {{token}}\n# @end-auth\n\n' +
      'GET https://api.example.com\nAuthorization: Bearer tampered\n'
    const parsed = parseHttpFile(text).requests[0]
    expect(parsed.auth).toEqual({ type: 'bearer', token: '{{token}}' })
    // The scheme owns the name: the divergent manual header is dropped from the
    // editable set entirely (owner decision), represented only by the block.
    expect(parsed.headers['Authorization']).toBeUndefined()
  })

  it('malformed block (unknown type) → warn, auth none, header kept as manual (CA-06)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const text =
      '# @auth\n# type: oauth2\n# token: {{token}}\n# @end-auth\n\n' +
      'GET https://api.example.com\nAuthorization: Bearer {{token}}\n'
    const parsed = parseHttpFile(text).requests[0]
    expect(parsed.auth).toBeUndefined()
    expect(parsed.headers['Authorization']).toBe('Bearer {{token}}')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('malformed block (missing required field) → warn + none', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const parsed = parseHttpFile('# @auth\n# type: bearer\n# @end-auth\n\nGET https://x\n')
      .requests[0]
    expect(parsed.auth).toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  // An unterminated block used to consume the rest of the block text, so the
  // request line below it disappeared entirely — silently, with no warning. It
  // degrades like every other malformed block instead (CA-06).
  it('unterminated block → warn, auth none, and the request survives', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const parsed = parseHttpFile(
      ['# @auth', '# type: basic', '# username: u', '', 'GET https://x/y', ''].join('\n')
    )
    expect(parsed.requests).toHaveLength(1)
    expect(parsed.requests[0].method).toBe('GET')
    expect(parsed.requests[0].url).toBe('https://x/y')
    expect(parsed.requests[0].auth).toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('malformed block (unknown key) → warn + none', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const parsed = parseHttpFile(
      '# @auth\n# type: bearer\n# token: t\n# bogus: x\n# @end-auth\n\nGET https://x\n'
    ).requests[0]
    expect(parsed.auth).toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('empty-field Basic round-trips (§10 Q3)', () => {
    const text = serializeRequest(
      state({ url: 'https://x', auth: { type: 'basic', username: '{{user}}', password: '' } })
    )
    const parsed = parseHttpFile(text).requests[0]
    expect(parsed.auth).toEqual({ type: 'basic', username: '{{user}}', password: '' })
  })

  // ── CLI parity (CA-07): the runner re-materializes via applyAuth ──────────
  it('CLI parity: parsed scheme re-applies to the identical outgoing request (CA-07)', () => {
    const text = serializeRequest(
      state({ url: 'https://api.example.com/users', auth: { type: 'bearer', token: 'abc' } })
    )
    const parsed = parseHttpFile(text).requests[0]
    const sent = applyAuth(parsed, parsed.auth)
    expect(sent.headers['Authorization']).toBe('Bearer abc')
  })

  it('CLI parity: api-key query is applied once (no double) after round-trip', () => {
    const text = serializeRequest(
      state({
        url: 'https://api.example.com/users',
        params: [{ id: 'p1', key: 'page', value: '1', enabled: true }],
        auth: { type: 'api-key', key: 'api_key', value: 'secret', location: 'query' }
      })
    )
    const parsed = parseHttpFile(text).requests[0]
    const sent = applyAuth(parsed, parsed.auth)
    expect(sent.url.match(/api_key=secret/g)).toHaveLength(1)
  })
})
