import { describe, it, expect } from 'vitest'
import { serializeRequest, splitUrlAndParams } from './http-serializer'
import { DEFAULT_REQUEST_STATE } from '../types'
import type { KeyValuePair, RequestEditorState } from '../types'

function state(overrides: Partial<RequestEditorState>): RequestEditorState {
  return { ...DEFAULT_REQUEST_STATE, ...overrides }
}

function kv(id: string, key: string, value: string, enabled = true): KeyValuePair {
  return { id, key, value, enabled }
}

describe('serializeRequest — auth persistence (REQ-0083)', () => {
  it('writes the @auth block after @settings and the echo header first', () => {
    const out = serializeRequest(
      state({
        method: 'GET',
        url: 'https://api.example.com/users',
        headers: [{ id: 'h1', key: 'Accept', value: 'application/json', enabled: true }],
        auth: { type: 'bearer', token: '{{token}}' }
      })
    )
    const lines = out.split('\n')
    expect(lines).toContain('# @auth')
    expect(lines).toContain('# type: bearer')
    expect(lines).toContain('# token: {{token}}')
    expect(lines).toContain('# @end-auth')
    // Echo header sits immediately after the request line, before hand-authored headers.
    const reqLineIdx = lines.findIndex((l) => l.startsWith('GET '))
    expect(lines[reqLineIdx + 1]).toBe('Authorization: Bearer {{token}}')
    const acceptIdx = lines.findIndex((l) => l === 'Accept: application/json')
    expect(acceptIdx).toBeGreaterThan(reqLineIdx + 1)
  })

  it('basic echo is unencoded (encoding happens at send time)', () => {
    const out = serializeRequest(
      state({ url: 'https://x', auth: { type: 'basic', username: '{{u}}', password: '{{p}}' } })
    )
    expect(out).toContain('Authorization: Basic {{u}}:{{p}}')
  })

  it('api-key query writes the echo as the leading query parameter', () => {
    const out = serializeRequest(
      state({
        url: 'https://api.example.com/users',
        params: [{ id: 'p1', key: 'page', value: '1', enabled: true }],
        auth: { type: 'api-key', key: 'api_key', value: '{{apiKey}}', location: 'query' }
      })
    )
    expect(out).toContain('?api_key={{apiKey}}&page=1')
  })

  it('none writes neither block nor echo (CA-03)', () => {
    const out = serializeRequest(state({ url: 'https://api.example.com', auth: { type: 'none' } }))
    expect(out).not.toContain('@auth')
    expect(out).not.toContain('Authorization')
  })

  it('a manual same-name header is dropped — only the echo is written (§6.4)', () => {
    const out = serializeRequest(
      state({
        url: 'https://x',
        headers: [{ id: 'h1', key: 'Authorization', value: 'Bearer manual', enabled: true }],
        auth: { type: 'bearer', token: '{{token}}' }
      })
    )
    const lines = out.split('\n').filter((l) => l.startsWith('Authorization:'))
    expect(lines).toEqual(['Authorization: Bearer {{token}}'])
  })

  it('a manual same-name query param is dropped — only the echo is written', () => {
    const out = serializeRequest(
      state({
        url: 'https://x',
        params: [
          { id: 'p1', key: 'api_key', value: 'manual', enabled: true },
          { id: 'p2', key: 'page', value: '1', enabled: true }
        ],
        auth: { type: 'api-key', key: 'api_key', value: '{{apiKey}}', location: 'query' }
      })
    )
    expect(out).toContain('?api_key={{apiKey}}&page=1')
    expect(out).not.toContain('api_key=manual')
  })

  it('saving the same non-none scheme twice is byte-identical', () => {
    const s = state({ url: 'https://x', auth: { type: 'bearer', token: '{{token}}' } })
    expect(serializeRequest(s)).toBe(serializeRequest(s))
  })
})

describe('serializeRequest — rawSubtype persistence', () => {
  it('writes `# @rawSubtype: xml` when bodyType=raw and subtype is xml', () => {
    const out = serializeRequest(
      state({
        method: 'POST',
        url: 'https://api.example.com/x',
        bodyType: 'raw',
        rawSubtype: 'xml',
        body: '<user/>'
      })
    )
    expect(out).toContain('# @rawSubtype: xml')
    expect(out).toContain('<user/>')
    // Body-mode declaration lives in the metadata region, before the request
    // line (D-META); the body sits after the header section's blank line.
    const lines = out.split('\n')
    const markerIdx = lines.findIndex((l) => l.startsWith('# @rawSubtype:'))
    const reqIdx = lines.findIndex((l) => l.startsWith('POST '))
    expect(markerIdx).toBeGreaterThanOrEqual(0)
    expect(markerIdx).toBeLessThan(reqIdx)
    // Body sits after the header section's blank line.
    expect(out).toContain('\n\n<user/>')
  })

  it('skips the marker for the default text subtype', () => {
    const out = serializeRequest(
      state({
        method: 'POST',
        url: 'https://api.example.com/x',
        bodyType: 'raw',
        rawSubtype: 'text',
        body: 'plain text body'
      })
    )
    expect(out).not.toContain('# @rawSubtype:')
    expect(out).toContain('plain text body')
  })

  it('writes the marker for json, javascript, and html as well', () => {
    for (const sub of ['json', 'javascript', 'html'] as const) {
      const out = serializeRequest(
        state({
          method: 'POST',
          url: 'https://api.example.com/x',
          bodyType: 'raw',
          rawSubtype: sub,
          body: 'x'
        })
      )
      expect(out).toContain(`# @rawSubtype: ${sub}`)
    }
  })

  it('does not write the marker when there is no body', () => {
    const out = serializeRequest(
      state({
        method: 'GET',
        url: 'https://api.example.com/x',
        bodyType: 'raw',
        rawSubtype: 'xml',
        body: ''
      })
    )
    expect(out).not.toContain('# @rawSubtype:')
  })

  it('does not write the marker for non-raw body types', () => {
    const out = serializeRequest(
      state({
        method: 'POST',
        url: 'https://api.example.com/x',
        bodyType: 'x-www-form-urlencoded',
        rawSubtype: 'xml',
        formFields: [{ id: 'f-0', key: 'a', value: '1', enabled: true }]
      })
    )
    expect(out).not.toContain('# @rawSubtype:')
    expect(out).toContain('a=1')
  })
})

// REQ-0080 — query-param token preservation on the save path.
describe('serializeRequest — query token preservation (REQ-0080)', () => {
  function serializeWithParams(params: KeyValuePair[]): string {
    return serializeRequest(state({ method: 'GET', url: 'https://api.example.com/x', params }))
  }

  it('CA-01: token in value preserved (no percent-encoded braces)', () => {
    const out = serializeWithParams([kv('1', 'clientId', '{{clientId}}')])
    expect(out).toContain('clientId={{clientId}}')
    expect(out).not.toContain('%7B%7B')
  })

  it('CA-02: token in key preserved', () => {
    const out = serializeWithParams([kv('1', '{{header}}', '1')])
    expect(out).toContain('{{header}}=1')
    expect(out).not.toContain('%7B%7B')
  })

  it('CA-03: literal special characters still encoded alongside a token', () => {
    const out = serializeWithParams([kv('1', 'q', 'a&b {{x}}')])
    expect(out).toContain('q=a%26b%20{{x}}')
  })

  it('CA-06: empty braces are not a token (fully encoded)', () => {
    const out = serializeWithParams([kv('1', 'k', '{{}}')])
    expect(out).toContain('k=%7B%7B%7D%7D')
  })

  it('CA-07: nested braces preserve only the inner match', () => {
    const out = serializeWithParams([kv('1', 'k', '{{a{{b}}}}')])
    expect(out).toContain('k=%7B%7Ba{{b}}%7D%7D')
  })

  it('CA-04 / CA-08: idempotent re-save round-trips byte-identically', () => {
    for (const value of ['{{clientId}}', 'user-{{userId}}', 'a&b {{x}}', '{{a%41b}}']) {
      const first = serializeWithParams([kv('1', 'k', value)])
      // Pull the stored query back out, re-load it, and re-serialize.
      const url = first.split('\n').find((l) => l.includes('?'))!
      const rawUrl = url.replace(/^\S+\s+/, '').replace(/\s+HTTP.*$/, '')
      const { params } = splitUrlAndParams(rawUrl)
      const second = serializeWithParams(params)
      expect(second).toBe(first)
    }
  })
})

describe('serializeRequest — malformed query param drop on save (REQ-0086)', () => {
  function serializeWithParams(params: KeyValuePair[]): string {
    return serializeRequest(state({ method: 'GET', url: 'https://api.example.com/x', params }))
  }

  // CA-05: saving a request with a malformed param drops it; the rest is unchanged.
  it('CA-05: a malformed param is dropped, well-formed siblings persist', () => {
    const out = serializeWithParams([
      kv('1', 'ok', 'a b'),
      { id: '2', key: '%E0', value: 'bad', enabled: true, malformed: true }
    ])
    expect(out).toContain('ok=a%20b')
    expect(out).not.toContain('%E0')
    expect(out).not.toContain('bad')
  })

  // CA-06: once the flag is cleared (hand-edit), the param is persisted normally.
  it('CA-06: a param whose malformed flag was cleared is persisted', () => {
    const out = serializeWithParams([
      { id: '1', key: 'fixed', value: 'value', enabled: true, malformed: false }
    ])
    expect(out).toContain('fixed=value')
  })

  // Regression: a well-formed param (no flag) is unaffected by the drop filter.
  it('a well-formed param without the flag is unchanged', () => {
    const out = serializeWithParams([kv('1', 'k', 'v')])
    expect(out).toContain('k=v')
  })
})

// REQ-0081 §6.4 — form-urlencoded body token preservation on the save path.
describe('serializeRequest — form-body token preservation (REQ-0081)', () => {
  function serializeForm(formFields: KeyValuePair[]): string {
    return serializeRequest(
      state({
        method: 'POST',
        url: 'https://api.example.com/x',
        bodyType: 'x-www-form-urlencoded',
        formFields
      })
    )
  }

  it('CA-07: token in a form field value preserved (no percent-encoded braces)', () => {
    const out = serializeForm([kv('f-0', 'access_token', '{{token}}')])
    expect(out).toContain('access_token={{token}}')
    expect(out).not.toContain('%7B%7B')
  })

  it('token in a form field key preserved', () => {
    const out = serializeForm([kv('f-0', '{{fieldName}}', 'v')])
    expect(out).toContain('{{fieldName}}=v')
  })

  it('literal special characters still encoded alongside a token', () => {
    const out = serializeForm([kv('f-0', 'q', 'a&b {{x}}')])
    expect(out).toContain('q=a%26b%20{{x}}')
  })
})

// ── Value-less query parameters (REQ-0124) ──────────────────────────────────

describe('serializeRequest — value-less query params (REQ-0124)', () => {
  function flag(id: string, key: string, enabled = true): KeyValuePair {
    return { id, key, value: '', enabled, valueless: true }
  }

  it('writes a value-less param as a bare key in the request line', () => {
    const out = serializeRequest(
      state({ method: 'GET', url: 'https://svc/orders.aspx', params: [flag('1', 'wsdl')] })
    )
    expect(out).toContain('GET https://svc/orders.aspx?wsdl\n')
    expect(out).not.toContain('?wsdl=')
  })

  it('keeps an empty-valued param distinct, with its `=`', () => {
    const out = serializeRequest(
      state({ method: 'GET', url: 'https://svc/orders.aspx', params: [kv('1', 'wsdl', '')] })
    )
    expect(out).toContain('GET https://svc/orders.aspx?wsdl=\n')
  })

  it('preserves a {{token}} in a value-less key, unencoded and with no `=`', () => {
    const out = serializeRequest(
      state({ method: 'GET', url: 'https://api/x', params: [flag('1', '{{flagName}}')] })
    )
    expect(out).toContain('GET https://api/x?{{flagName}}\n')
  })

  it('persists a disabled value-less param without an `=`', () => {
    const out = serializeRequest(
      state({
        method: 'GET',
        url: 'https://svc/orders.aspx',
        params: [flag('1', 'wsdl', false), kv('2', 'page', '2')]
      })
    )
    expect(out).toContain('# @disabled param 0 wsdl\n')
    expect(out).toContain('GET https://svc/orders.aspx?page=2\n')
  })
})
