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

  it('derives the raw Content-Type from the subtype unless set explicitly', () => {
    const payload = buildHttpRequestPayload(
      baseState({ bodyType: 'raw', rawSubtype: 'json', body: '{"a":1}' }),
      {}
    )
    expect(payload.headers['Content-Type']).toBe('application/json')
    expect(payload.body).toBe('{"a":1}')
  })
})
