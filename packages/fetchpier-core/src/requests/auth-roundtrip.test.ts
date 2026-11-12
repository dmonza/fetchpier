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
    const file = parseHttpFile(text)
    const parsed = file.requests[0]
    expect(parsed.auth).toBeUndefined()
    expect(parsed.headers['Authorization']).toBe('Bearer {{token}}')
    expect(file.warnings?.some((w) => w.includes('# @auth'))).toBe(true)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('malformed block (missing required field) → warn + none', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const file = parseHttpFile('# @auth\n# type: bearer\n# @end-auth\n\nGET https://x\n')
    expect(file.requests[0].auth).toBeUndefined()
    expect(file.warnings).toHaveLength(1)
    expect(warn).not.toHaveBeenCalled()
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
    expect(parsed.warnings?.[0]).toContain('missing "# @end-auth"')
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('malformed block (unknown key) → warn + none', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const file = parseHttpFile(
      '# @auth\n# type: bearer\n# token: t\n# bogus: x\n# @end-auth\n\nGET https://x\n'
    )
    expect(file.requests[0].auth).toBeUndefined()
    expect(file.warnings).toHaveLength(1)
    expect(warn).not.toHaveBeenCalled()
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

// FMT-16: query names are case-sensitive; the scheme owns its exact (trimmed) name only.
describe('api-key query name matching (FMT-16)', () => {
  const API_KEY_FILE =
    '# @auth\n# type: api-key\n# key: api_key\n# value: secret\n# location: query\n# @end-auth\n\n' +
    'GET https://api.example.com/items?api_key=secret&API_KEY=other\n'

  it('keeps a param that differs only in case on load, save and the CLI send', () => {
    const parsed = parseHttpFile(API_KEY_FILE).requests[0]
    expect(parsed.url).toBe('https://api.example.com/items?API_KEY=other')

    const reopened = reopen(parsed)
    expect(reopened.params.map((p) => p.key)).toEqual(['API_KEY'])
    expect(serializeRequest(reopened)).toContain(
      'GET https://api.example.com/items?api_key=secret&API_KEY=other'
    )
    expect(applyAuth(parsed, parsed.auth).url).toBe(
      'https://api.example.com/items?API_KEY=other&api_key=secret'
    )
  })

  it('a re-save after reopen is byte-identical', () => {
    const first = serializeRequest(reopen(parseHttpFile(API_KEY_FILE).requests[0]))
    const second = serializeRequest(reopen(parseHttpFile(first).requests[0]))
    expect(second).toBe(first)
  })

  it('still drops a manual param with the exact name, on save', () => {
    const text = serializeRequest(
      state({
        url: 'https://api.example.com/items',
        params: [
          { id: 'p1', key: 'api_key', value: 'manual', enabled: true },
          { id: 'p2', key: 'page', value: '1', enabled: true }
        ],
        auth: { type: 'api-key', key: 'api_key', value: 'secret', location: 'query' }
      })
    )
    expect(text).toContain('GET https://api.example.com/items?api_key=secret&page=1')
    expect(text).not.toContain('manual')
  })
})

// FMT-01: a fragment after the echo survives the parser's strip of the scheme's param.
describe('api-key query echo next to a fragment (FMT-01)', () => {
  const block =
    '# @auth\n# type: api-key\n# key: api_key\n# value: s\n# location: query\n# @end-auth\n\n'

  it.each([
    ['the echo last', 'items?page=2&api_key=s#top', 'items?page=2#top'],
    ['the echo alone', 'items?api_key=s#top', 'items#top']
  ])('strips only the echo, keeping the fragment (%s)', (_label, written, expected) => {
    const parsed = parseHttpFile(`${block}GET https://api.example.com/${written}\n`).requests[0]
    expect(parsed.url).toBe(`https://api.example.com/${expected}`)
  })
})

// FMT-17: only the key and the single separator space are structure; the value is verbatim.
describe('auth field whitespace (FMT-17)', () => {
  it.each<AuthConfig>([
    { type: 'bearer', token: ' abc ' },
    { type: 'basic', username: '  alice', password: ' p ' },
    { type: 'api-key', key: 'X-Key', value: 'v  ', location: 'header' }
  ])('keeps leading and trailing whitespace across save → load → save ($type)', (auth) => {
    const first = serializeRequest(state({ url: 'https://api.example.com', auth }))
    const parsed = parseHttpFile(first).requests[0]
    expect(parsed.auth).toEqual(auth)
    expect(serializeRequest(reopen(parsed))).toBe(first)
  })

  it.each([
    ['no separator space', '# token:abc', 'abc'],
    ['one separator space', '# token: abc', 'abc'],
    ['two spaces', '# token:  abc', ' abc'],
    ['a trailing space', '# token: abc ', 'abc ']
  ])('reads a hand-written value with %s', (_label, line, expected) => {
    const text = `# @auth\n# type: bearer\n${line}\n# @end-auth\n\nGET https://api.example.com\n`
    expect(parseHttpFile(text).requests[0].auth).toEqual({ type: 'bearer', token: expected })
  })

  it('still reads padded `type` and `location` keywords', () => {
    const text =
      '# @auth\n#   type:  api-key \n# key: k\n# value: v\n# location:  query \n# @end-auth\n\n' +
      'GET https://api.example.com\n'
    const file = parseHttpFile(text)
    expect(file.requests[0].auth).toEqual({
      type: 'api-key',
      key: 'k',
      value: 'v',
      location: 'query'
    })
    expect(file.warnings).toBeUndefined()
  })

  // The api-key `key` is a header or query-parameter name, never a credential: a
  // padded name would make undici reject the header, or send `%20api_key=`.
  it.each([
    ['aligned columns', '# key:  X-API-Key'],
    ['a trailing space', '# key: X-API-Key ']
  ])('reads a padded api-key name (%s) as the bare name', (_label, line) => {
    const text =
      `# @auth\n# type: api-key\n${line}\n# value: v\n# location: header\n# @end-auth\n\n` +
      'GET https://api.example.com\n'
    expect(parseHttpFile(text).requests[0].auth).toEqual({
      type: 'api-key',
      key: 'X-API-Key',
      value: 'v',
      location: 'header'
    })
  })
})
