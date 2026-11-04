import { describe, it, expect } from 'vitest'
import { mapHttpRequestToEditorState } from './request-loader'
import { serializeRequest } from '@shared/lib/http-serializer'
import { DEFAULT_REQUEST_STATE } from '../../../shared/types'
import type {
  HttpRequest,
  BinaryFileAttachment,
  MultipartPart,
  RequestEditorState
} from '../../../shared/types'

function makeRequest(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    method: 'GET',
    url: 'https://example.com',
    headers: {},
    ...overrides
  }
}

describe('mapHttpRequestToEditorState — malformed query containment (REQ-0086)', () => {
  // CA-04 (load half): a malformed query key loads without throwing, kept raw and
  // flagged. The RequestEditor derives the dirty mark + advisory from this flag.
  it('keeps a malformed query key raw and flags it', () => {
    const result = mapHttpRequestToEditorState(makeRequest({ url: 'https://example.com/x?%E0=v' }))
    expect(result.url).toBe('https://example.com/x')
    expect(result.params).toEqual([
      { id: 'param-0', key: '%E0', value: 'v', enabled: true, malformed: true }
    ])
    expect(result.params.some((p) => p.malformed)).toBe(true)
  })

  it('does not flag a well-formed query (no malformed params)', () => {
    const result = mapHttpRequestToEditorState(
      makeRequest({ url: 'https://example.com/x?a=b%20c' })
    )
    expect(result.params.some((p) => p.malformed)).toBe(false)
  })
})

describe('mapHttpRequestToEditorState — disabled rows (CA-04)', () => {
  it('re-interleaves a disabled header at its original position, still disabled', () => {
    const result = mapHttpRequestToEditorState(
      makeRequest({
        headers: { 'X-One': '1', 'X-Three': '3', 'User-Agent': 'ua' },
        headerList: [
          { name: 'X-One', value: '1' },
          { name: 'X-Three', value: '3' },
          { name: 'User-Agent', value: 'ua' }
        ],
        disabledRows: [{ kind: 'header', pos: 1, key: 'X-Two', value: '2' }]
      })
    )
    const xTwo = result.headers.find((h) => h.key === 'X-Two')
    expect(xTwo).toMatchObject({ key: 'X-Two', value: '2', enabled: false })
    // Re-inserted at position 1 (after X-One).
    expect(result.headers[1].key).toBe('X-Two')
  })

  it('re-interleaves disabled params and fields', () => {
    const result = mapHttpRequestToEditorState(
      makeRequest({
        url: 'https://example.com/x?a=1',
        disabledRows: [{ kind: 'param', pos: 1, key: 'b', value: '2' }]
      })
    )
    expect(result.params.find((p) => p.key === 'b')).toMatchObject({ value: '2', enabled: false })
  })
})

describe('mapHttpRequestToEditorState — duplicate headers (CA-03)', () => {
  it('maps the ordered headerList into editor rows, preserving duplicates', () => {
    const result = mapHttpRequestToEditorState(
      makeRequest({
        headers: { Accept: 'text/html', 'User-Agent': 'ua' },
        headerList: [
          { name: 'Accept', value: 'application/json' },
          { name: 'Accept', value: 'text/html' },
          { name: 'User-Agent', value: 'ua' }
        ]
      })
    )
    expect(result.headers.map((h) => [h.key, h.value])).toEqual([
      ['Accept', 'application/json'],
      ['Accept', 'text/html'],
      ['User-Agent', 'ua']
    ])
  })

  it('falls back to the lossy record when no headerList is present', () => {
    const result = mapHttpRequestToEditorState(
      makeRequest({ headers: { 'X-One': '1', 'User-Agent': 'ua' } })
    )
    expect(result.headers.find((h) => h.key === 'X-One')?.value).toBe('1')
  })
})

describe('mapHttpRequestToEditorState', () => {
  it('maps a multipart-form request: bodyType, empty body, parts preserved', () => {
    const parts: MultipartPart[] = [
      { kind: 'text', id: 'p1', name: 'model', value: 'gpt-4o-transcribe' },
      {
        kind: 'file',
        id: 'p2',
        name: 'file',
        file: {
          ref: 'a'.repeat(64) + '__fetchpier_en.mp3',
          originalName: 'fetchpier_en.mp3',
          sizeBytes: 32_896,
          mimeType: 'audio/mpeg'
        }
      }
    ]
    const result = mapHttpRequestToEditorState(
      makeRequest({
        method: 'POST',
        url: '{{baseUrl}}/audio/transcriptions',
        headers: { Authorization: 'Bearer {{apiKey}}', Accept: 'application/json' },
        bodyType: 'multipart-form',
        multipartParts: parts
      })
    )

    expect(result.bodyType).toBe('multipart-form')
    expect(result.multipartParts).toEqual(parts)
    expect(result.body).toBe('')
    expect(result.binaryFile).toBeUndefined()
    expect(result.method).toBe('POST')
    expect(result.url).toBe('{{baseUrl}}/audio/transcriptions')
  })

  it('maps a binary request: bodyType, empty body, binaryFile preserved', () => {
    const binaryFile: BinaryFileAttachment = {
      ref: 'b'.repeat(64) + '__photo.jpg',
      originalName: 'photo.jpg',
      sizeBytes: 12345,
      mimeType: 'image/jpeg'
    }
    const result = mapHttpRequestToEditorState(
      makeRequest({
        method: 'POST',
        url: 'https://example.com/upload',
        headers: { 'Content-Type': 'image/jpeg' },
        bodyType: 'binary',
        binaryFile
      })
    )

    expect(result.bodyType).toBe('binary')
    expect(result.binaryFile).toEqual(binaryFile)
    expect(result.body).toBe('')
    expect(result.multipartParts).toBeUndefined()
  })

  it('maps an x-www-form-urlencoded request: parses key/value pairs', () => {
    const result = mapHttpRequestToEditorState(
      makeRequest({
        method: 'POST',
        url: 'https://example.com/form',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'name=Juan&age=30'
      })
    )

    expect(result.bodyType).toBe('x-www-form-urlencoded')
    expect(result.body).toBe('')
    expect(
      result.formFields.map((f) => ({ key: f.key, value: f.value, enabled: f.enabled }))
    ).toEqual([
      { key: 'name', value: 'Juan', enabled: true },
      { key: 'age', value: '30', enabled: true }
    ])
  })

  // REQ-0081 §6.4 — form-body token-aware load (mirrors the query load path).
  it('CA-07: preserves `{{token}}` verbatim in a form field value on load', () => {
    const result = mapHttpRequestToEditorState(
      makeRequest({
        method: 'POST',
        url: 'https://example.com/token',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials&client_id={{clientId}}'
      })
    )
    expect(result.formFields.map((f) => ({ key: f.key, value: f.value }))).toEqual([
      { key: 'grant_type', value: 'client_credentials' },
      { key: 'client_id', value: '{{clientId}}' }
    ])
  })

  it('decodes only literal segments; a `%` inside a token round-trips without corruption or throwing', () => {
    const result = mapHttpRequestToEditorState(
      makeRequest({
        method: 'POST',
        url: 'https://example.com/x',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'a={{a%41b}}&b=x%20y&c={{a%b}}'
      })
    )
    expect(result.formFields.map((f) => ({ key: f.key, value: f.value }))).toEqual([
      { key: 'a', value: '{{a%41b}}' },
      { key: 'b', value: 'x y' },
      { key: 'c', value: '{{a%b}}' }
    ])
  })

  it('CA-07: form body round-trips byte-identically (save -> load -> save)', () => {
    const formFields = [
      { id: 'f-0', key: 'grant_type', value: 'client_credentials', enabled: true },
      { id: 'f-1', key: 'client_id', value: '{{clientId}}', enabled: true },
      { id: 'f-2', key: 'note', value: 'a&b {{x}}', enabled: true }
    ]
    const formState = (fields: typeof formFields): RequestEditorState => ({
      ...DEFAULT_REQUEST_STATE,
      method: 'POST',
      url: 'https://example.com/token',
      bodyType: 'x-www-form-urlencoded',
      formFields: fields
    })

    const firstHttp = serializeRequest(formState(formFields))
    const bodyLine = firstHttp.split('\n').find((l) => l.startsWith('grant_type='))!
    // Token written verbatim on the save side.
    expect(bodyLine).toContain('client_id={{clientId}}')

    const loaded = mapHttpRequestToEditorState(
      makeRequest({
        method: 'POST',
        url: 'https://example.com/token',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: bodyLine
      })
    )
    const secondHttp = serializeRequest(formState(loaded.formFields))
    expect(secondHttp).toBe(firstHttp)
  })

  it('maps a raw JSON request: bodyType raw with inferred rawSubtype', () => {
    const result = mapHttpRequestToEditorState(
      makeRequest({
        method: 'POST',
        url: 'https://example.com/api/users',
        headers: { 'Content-Type': 'application/json' },
        body: '{"name":"Juan"}'
      })
    )

    expect(result.bodyType).toBe('raw')
    expect(result.rawSubtype).toBe('json')
    expect(result.body).toBe('{"name":"Juan"}')
    expect(result.multipartParts).toBeUndefined()
    expect(result.binaryFile).toBeUndefined()
  })

  it('honors an explicit rawSubtype from the parser over Content-Type inference', () => {
    const result = mapHttpRequestToEditorState(
      makeRequest({
        method: 'POST',
        url: 'https://example.com/api',
        headers: { 'Content-Type': 'application/json' },
        body: '<root/>',
        rawSubtype: 'xml'
      })
    )

    expect(result.bodyType).toBe('raw')
    expect(result.rawSubtype).toBe('xml')
  })

  it('maps an empty-body request to bodyType none', () => {
    const result = mapHttpRequestToEditorState(makeRequest())

    expect(result.bodyType).toBe('none')
    expect(result.body).toBe('')
    expect(result.formFields).toEqual([])
    expect(result.multipartParts).toBeUndefined()
    expect(result.binaryFile).toBeUndefined()
  })

  // The default User-Agent is implicit: applied at send time, shown as a
  // read-only default row, never inserted as an editable header — inserting it
  // is what wrote a version into every saved file.
  it('does not insert a User-Agent header the file does not have', () => {
    const result = mapHttpRequestToEditorState(
      makeRequest({ headers: { Accept: 'application/json' } })
    )
    expect(result.headers.map((h) => h.key)).toEqual(['Accept'])
  })

  it('keeps a user-supplied User-Agent and does not duplicate it', () => {
    const result = mapHttpRequestToEditorState(
      makeRequest({ headers: { 'User-Agent': 'Custom/1.0' } })
    )
    const uas = result.headers.filter((h) => h.key.toLowerCase() === 'user-agent')
    expect(uas).toHaveLength(1)
    expect(uas[0].value).toBe('Custom/1.0')
  })

  it('separates query string into params', () => {
    const result = mapHttpRequestToEditorState(
      makeRequest({ url: 'https://example.com/search?q=hola&page=2' })
    )
    expect(result.url).toBe('https://example.com/search')
    expect(result.params.map((p) => ({ key: p.key, value: p.value }))).toEqual([
      { key: 'q', value: 'hola' },
      { key: 'page', value: '2' }
    ])
  })

  it('promotes disableCookieJar=true to RequestSettings override', () => {
    const result = mapHttpRequestToEditorState(makeRequest({ disableCookieJar: true }))
    expect(result.settings.disableCookieJar).toEqual({ inherit: false, value: true })
  })

  it('does not crash when bodyType is multipart-form but multipartParts is missing (defensive fallback)', () => {
    const result = mapHttpRequestToEditorState(makeRequest({ bodyType: 'multipart-form' }))
    // Falls through to default 'none' branch — empty/malformed multipart is treated as no body.
    expect(result.bodyType).toBe('none')
    expect(result.multipartParts).toBeUndefined()
  })

  // ── REQ-0083: auth hydration ───────────────────────────────────────────────
  it('hydrates the auth scheme from the parsed request (REQ-0083)', () => {
    const result = mapHttpRequestToEditorState(
      makeRequest({ auth: { type: 'bearer', token: '{{token}}' } })
    )
    expect(result.auth).toEqual({ type: 'bearer', token: '{{token}}' })
  })

  it('defaults to auth none when the parsed request carries no scheme', () => {
    const result = mapHttpRequestToEditorState(makeRequest())
    expect(result.auth).toEqual({ type: 'none' })
  })
})

// ── Value-less query parameters (REQ-0124) ──────────────────────────────────

describe('mapHttpRequestToEditorState — value-less query params (REQ-0124)', () => {
  it('flags a param the stored URL wrote without `=`, and not its empty-valued sibling', () => {
    const flagged = mapHttpRequestToEditorState(
      makeRequest({ url: 'https://svc/orders.aspx?wsdl' })
    )
    expect(flagged.url).toBe('https://svc/orders.aspx')
    expect(flagged.params[0]).toMatchObject({ key: 'wsdl', value: '', valueless: true })

    const empty = mapHttpRequestToEditorState(makeRequest({ url: 'https://svc/orders.aspx?wsdl=' }))
    expect(empty.params[0]).toMatchObject({ key: 'wsdl', value: '' })
    expect(empty.params[0].valueless).toBeFalsy()
  })

  it('re-interleaves a disabled value-less param with its flag intact', () => {
    const result = mapHttpRequestToEditorState(
      makeRequest({
        url: 'https://svc/orders.aspx?a=1&c=3',
        disabledRows: [{ kind: 'param', pos: 1, key: 'wsdl', value: '', valueless: true }]
      })
    )
    expect(result.params.map((p) => [p.key, p.enabled, Boolean(p.valueless)])).toEqual([
      ['a', true, false],
      ['wsdl', false, true],
      ['c', true, false]
    ])
  })

  it('round-trips a value-less param through serialize → load', () => {
    const loaded = mapHttpRequestToEditorState(makeRequest({ url: 'https://svc/x?wsdl' }))
    const text = serializeRequest({ ...DEFAULT_REQUEST_STATE, ...loaded })
    expect(text).toContain('GET https://svc/x?wsdl\n')
  })
})
