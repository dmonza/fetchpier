import { describe, it, expect } from 'vitest'
import type { RequestEditorState } from '../../../shared/types'
import { buildHttpRequestPayload } from './build-send-payload'

function baseState(overrides: Partial<RequestEditorState> = {}): RequestEditorState {
  return {
    method: 'GET',
    url: 'https://api.example.com/token',
    params: [],
    headers: [],
    bodyType: 'none',
    rawSubtype: 'json',
    body: '',
    formFields: [],
    auth: { type: 'none' },
    preRequestScript: '',
    postResponseScript: '',
    settings: {},
    ...overrides
  }
}

describe('buildHttpRequestPayload (REQ-0081)', () => {
  // CA-03: the representation handed to the core carries the literal token,
  // unencoded, in the structured query — never `%7B%7B…`, and `url` stays base.
  it('CA-03: hands the core verbatim tokens in structured params, no %7B%7B in url', () => {
    const payload = buildHttpRequestPayload(
      baseState({
        params: [
          { id: 'p0', key: 'apiKey', value: '{{apiKey}}', enabled: true },
          { id: 'p1', key: 'region', value: '{{region}}', enabled: true }
        ]
      }),
      {}
    )

    expect(payload.url).toBe('https://api.example.com/token')
    expect(payload.url).not.toContain('%7B%7B')
    expect(payload.params).toEqual([
      { id: 'p0', key: 'apiKey', value: '{{apiKey}}', enabled: true },
      { id: 'p1', key: 'region', value: '{{region}}', enabled: true }
    ])
    // The renderer no longer bakes the query into the URL string.
    expect(JSON.stringify(payload)).not.toContain('%7B%7B')
  })

  it('does not percent-encode special characters in query params (core owns encoding)', () => {
    const payload = buildHttpRequestPayload(
      baseState({ params: [{ id: 'p', key: 'q', value: 'a b&c', enabled: true }] }),
      {}
    )
    expect(payload.params).toEqual([{ id: 'p', key: 'q', value: 'a b&c', enabled: true }])
    expect(payload.url).toBe('https://api.example.com/token')
  })

  it('passes the active environment variables through', () => {
    const payload = buildHttpRequestPayload(baseState(), { clientId: 'abc' })
    expect(payload.variables).toEqual({ clientId: 'abc' })
  })

  it('sets the form-urlencoded Content-Type and passes formFields structured', () => {
    const payload = buildHttpRequestPayload(
      baseState({
        bodyType: 'x-www-form-urlencoded',
        formFields: [{ id: 'f', key: 'token', value: '{{token}}', enabled: true }]
      }),
      {}
    )
    expect(payload.headers['Content-Type']).toBe('application/x-www-form-urlencoded')
    expect(payload.body).toBeUndefined()
    expect(payload.formFields).toEqual([
      { id: 'f', key: 'token', value: '{{token}}', enabled: true }
    ])
  })

  // FMT-16: the scheme owns its exact (trimmed) name; query names are case-sensitive.
  it('drops only the param named exactly as the api-key query scheme', () => {
    const payload = buildHttpRequestPayload(
      baseState({
        params: [
          { id: 'p0', key: ' api_key ', value: 'manual', enabled: true },
          { id: 'p1', key: 'API_KEY', value: 'other', enabled: true },
          { id: 'p2', key: 'page', value: '1', enabled: true }
        ],
        auth: { type: 'api-key', key: 'api_key', value: 'secret', location: 'query' }
      }),
      {}
    )
    expect(payload.params?.map((p) => p.key)).toEqual(['API_KEY', 'page'])
  })

  // Per-request overrides travel as the editor holds them: the engine resolves
  // them against the workspace and reports what it applied. Dropping them made
  // every Settings-tab override a no-op on desktop sends.
  describe('per-request settings', () => {
    it('forwards overrides and inherits unchanged', () => {
      const settings = {
        followRedirects: { inherit: false as const, value: false },
        verifySsl: { inherit: true as const },
        maxRedirects: { inherit: false as const, value: 0 },
        disableCookieJar: { inherit: false as const, value: false }
      }
      const payload = buildHttpRequestPayload(baseState({ settings }), {})
      expect(payload.settings).toEqual(settings)
    })

    it('forwards an empty settings object as is', () => {
      expect(buildHttpRequestPayload(baseState({ settings: {} }), {}).settings).toEqual({})
    })

    it('carries the cookie-jar override inside settings, never as the top-level flag', () => {
      const payload = buildHttpRequestPayload(
        baseState({ settings: { disableCookieJar: { inherit: false, value: true } } }),
        {}
      )
      expect(payload.settings?.disableCookieJar).toEqual({ inherit: false, value: true })
      expect(payload).not.toHaveProperty('disableCookieJar')
    })
  })

  // The engine refuses a request whose binary reference is not valid instead of
  // sending it without the file — the payload must tell it.
  describe('invalid binary reference', () => {
    const file = {
      ref: `${'a'.repeat(64)}__a.bin`,
      originalName: 'a.bin',
      sizeBytes: 1,
      mimeType: 'application/octet-stream'
    }

    it('is forwarded while binary mode has no file', () => {
      const payload = buildHttpRequestPayload(
        baseState({ method: 'POST', bodyType: 'binary', invalidBinaryRef: 'not-a-ref' }),
        {}
      )
      expect(payload.invalidBinaryRef).toBe('not-a-ref')
    })

    it('is not forwarded once a valid file is attached', () => {
      const payload = buildHttpRequestPayload(
        baseState({ bodyType: 'binary', binaryFile: file, invalidBinaryRef: 'not-a-ref' }),
        {}
      )
      expect(payload).not.toHaveProperty('invalidBinaryRef')
      expect(payload.binaryFile).toEqual(file)
    })

    it('is not forwarded once the body leaves binary mode', () => {
      const payload = buildHttpRequestPayload(
        baseState({ bodyType: 'raw', body: 'x', invalidBinaryRef: 'not-a-ref' }),
        {}
      )
      expect(payload).not.toHaveProperty('invalidBinaryRef')
    })
  })

  it('derives the raw Content-Type from the subtype unless set explicitly', () => {
    const payload = buildHttpRequestPayload(
      baseState({ bodyType: 'raw', rawSubtype: 'json', body: '{"a":1}' }),
      {}
    )
    expect(payload.headers['Content-Type']).toBe('application/json')
    expect(payload.body).toBe('{"a":1}')
  })
})
