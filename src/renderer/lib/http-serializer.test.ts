import { describe, it, expect } from 'vitest'
import { computeFullUrl, splitUrlAndParams, serializeRequest } from '@shared/lib/http-serializer'
import type { KeyValuePair, RequestEditorState } from '../../shared/types'
import { DEFAULT_REQUEST_STATE } from '../../shared/types'

function makeState(overrides: Partial<RequestEditorState> = {}): RequestEditorState {
  return { ...DEFAULT_REQUEST_STATE, ...overrides }
}

function kv(id: string, key: string, value: string, enabled = true): KeyValuePair {
  return { id, key, value, enabled }
}

/** A query parameter authored with no `=` at all (REQ-0124). */
function flag(id: string, key: string, enabled = true): KeyValuePair {
  return { id, key, value: '', enabled, valueless: true }
}

// ── computeFullUrl ──────────────────────────────────────────────────────────

describe('computeFullUrl', () => {
  it('returns base URL when params array is empty', () => {
    expect(computeFullUrl('https://api.com/users', [])).toBe('https://api.com/users')
  })

  it('appends enabled params as query string', () => {
    const params = [kv('1', 'page', '1'), kv('2', 'limit', '10')]
    expect(computeFullUrl('https://api.com/users', params)).toBe(
      'https://api.com/users?page=1&limit=10'
    )
  })

  it('excludes disabled params', () => {
    const params = [kv('1', 'page', '1'), kv('2', 'limit', '10', false)]
    expect(computeFullUrl('https://api.com/users', params)).toBe('https://api.com/users?page=1')
  })

  it('excludes params with empty key', () => {
    const params = [kv('1', '', 'ignored'), kv('2', 'page', '1')]
    expect(computeFullUrl('https://api.com/users', params)).toBe('https://api.com/users?page=1')
  })

  it('returns base URL when all params are disabled or have empty keys', () => {
    const params = [kv('1', '', 'x', true), kv('2', 'key', 'val', false)]
    expect(computeFullUrl('https://api.com', params)).toBe('https://api.com')
  })

  it('appends bare ? when the only enabled params are empty placeholders', () => {
    const params = [kv('1', '', '')]
    expect(computeFullUrl('https://api.com', params)).toBe('https://api.com?')
  })

  it('handles empty value params', () => {
    const params = [kv('1', 'search', '')]
    expect(computeFullUrl('https://api.com', params)).toBe('https://api.com?search=')
  })

  // REQ-0124: the URL bar must render back exactly what was typed. A parameter
  // authored without `=` stays without it; its empty-valued sibling keeps the `=`.
  it('renders a value-less param as a bare key, and its empty-valued sibling with `=`', () => {
    expect(computeFullUrl('https://svc/orders.aspx', [flag('1', 'wsdl')])).toBe(
      'https://svc/orders.aspx?wsdl'
    )
    expect(computeFullUrl('https://svc/orders.aspx', [kv('1', 'wsdl', '')])).toBe(
      'https://svc/orders.aspx?wsdl='
    )
  })

  it('mixes value-less and valued params in author order', () => {
    const params = [kv('1', 'q', 'shoes'), flag('2', 'pretty'), kv('3', 'page', '2')]
    expect(computeFullUrl('https://api.com', params)).toBe('https://api.com?q=shoes&pretty&page=2')
  })

  it('renames a value-less param without introducing `=` (key edits preserve it)', () => {
    expect(computeFullUrl('https://svc/orders.aspx', [flag('1', 'servicio')])).toBe(
      'https://svc/orders.aspx?servicio'
    )
  })

  it('does not percent-encode values (for human-readable display)', () => {
    const params = [kv('1', 'q', 'hello world')]
    expect(computeFullUrl('https://api.com', params)).toBe('https://api.com?q=hello world')
  })
})

// ── splitUrlAndParams (round-trip with computeFullUrl) ──────────────────────

describe('splitUrlAndParams round-trip', () => {
  it('parses params typed in URL bar and rebuilds correctly', () => {
    const raw = 'https://api.com/users?page=1&limit=10'
    const { baseUrl, params } = splitUrlAndParams(raw)
    expect(baseUrl).toBe('https://api.com/users')
    expect(params).toHaveLength(2)
    expect(params[0]).toMatchObject({ key: 'page', value: '1', enabled: true })
    expect(params[1]).toMatchObject({ key: 'limit', value: '10', enabled: true })
    expect(computeFullUrl(baseUrl, params)).toBe(raw)
  })

  it('handles URL without query string', () => {
    const { baseUrl, params } = splitUrlAndParams('https://api.com/users')
    expect(baseUrl).toBe('https://api.com/users')
    expect(params).toHaveLength(0)
    expect(computeFullUrl(baseUrl, params)).toBe('https://api.com/users')
  })

  it('decodes percent-encoded values when parsing', () => {
    const { baseUrl, params } = splitUrlAndParams('https://api.com?q=hello%20world')
    expect(baseUrl).toBe('https://api.com')
    expect(params[0]).toMatchObject({ key: 'q', value: 'hello world' })
  })

  it('handles param with no value', () => {
    const { baseUrl, params } = splitUrlAndParams('https://api.com?foo')
    expect(baseUrl).toBe('https://api.com')
    expect(params[0]).toMatchObject({ key: 'foo', value: '' })
  })

  it('bare ? returns one empty placeholder param', () => {
    const { baseUrl, params } = splitUrlAndParams('https://api.com?')
    expect(baseUrl).toBe('https://api.com')
    expect(params).toHaveLength(1)
    expect(params[0]).toMatchObject({ key: '', value: '', enabled: true })
  })

  it('round-trip: bare ? rebuilds to bare ?', () => {
    const raw = 'https://api.com/users?'
    const { baseUrl, params } = splitUrlAndParams(raw)
    expect(computeFullUrl(baseUrl, params)).toBe(raw)
  })
})

// ── splitUrlAndParams token-aware load (REQ-0080 §6.4) ──────────────────────

describe('splitUrlAndParams — token-aware load (REQ-0080)', () => {
  it('CA-01/02: leaves {{variable}} tokens in key and value undecoded', () => {
    const { params } = splitUrlAndParams('https://api.com?{{header}}={{clientId}}')
    expect(params[0]).toMatchObject({ key: '{{header}}', value: '{{clientId}}' })
  })

  it('still decodes literal segments around a token', () => {
    const { params } = splitUrlAndParams('https://api.com?q=a%26b%20{{x}}')
    expect(params[0]).toMatchObject({ key: 'q', value: 'a&b {{x}}' })
  })

  it('CA-08: a valid-looking % escape inside a token is not decoded', () => {
    const { params } = splitUrlAndParams('https://api.com?k={{a%41b}}')
    expect(params[0]).toMatchObject({ key: 'k', value: '{{a%41b}}' })
  })

  it('CA-09: an invalid % escape inside a token does not throw on load', () => {
    expect(() => splitUrlAndParams('https://api.com?k={{a%b}}')).not.toThrow()
    const { params } = splitUrlAndParams('https://api.com?k={{a%b}}')
    expect(params[0]).toMatchObject({ key: 'k', value: '{{a%b}}' })
  })
})

// ── serializeRequest ↔ splitUrlAndParams round-trip (REQ-0080 CA-04/08) ──────

describe('query token round-trip (REQ-0080)', () => {
  function storedQuery(value: string): string {
    const out = serializeRequest(
      makeState({ method: 'GET', url: 'https://api.com/x', params: [kv('1', 'k', value)] })
    )
    const line = out.split('\n').find((l) => l.includes('?'))!
    return line.replace(/^\S+\s+/, '').replace(/\s+HTTP.*$/, '')
  }

  it.each(['{{clientId}}', 'user-{{userId}}', 'a&b {{x}}', '{{a%41b}}'])(
    'load → save is byte-identical for value %j',
    (value) => {
      const first = storedQuery(value)
      const { params } = splitUrlAndParams(first)
      const second = serializeRequest(
        makeState({ method: 'GET', url: 'https://api.com/x', params })
      )
        .split('\n')
        .find((l) => l.includes('?'))!
        .replace(/^\S+\s+/, '')
        .replace(/\s+HTTP.*$/, '')
      expect(second).toBe(first)
    }
  )

  it('CA-08: {{a%41b}} displays verbatim (not {{aAb}}) after load', () => {
    const stored = storedQuery('{{a%41b}}')
    const { params } = splitUrlAndParams(stored)
    expect(params[0].value).toBe('{{a%41b}}')
  })
})

// ── serializeRequest requestId ──────────────────────────────────────────────

describe('serializeRequest — requestId', () => {
  it('prepends # @id comment when requestId is provided', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000'
    const state = makeState({ method: 'GET', url: 'https://api.com' })
    const output = serializeRequest(state, id)
    expect(output.startsWith(`# @id ${id}\n`)).toBe(true)
  })

  it('does not add # @id comment when requestId is omitted', () => {
    const state = makeState({ method: 'GET', url: 'https://api.com' })
    const output = serializeRequest(state)
    expect(output).not.toContain('@id')
  })
})

// ── serializeRequest settings block ─────────────────────────────────────────

describe('serializeRequest — @settings block', () => {
  it('omits the block entirely when there are no overrides', () => {
    const state = makeState({
      method: 'GET',
      url: 'https://api.com',
      settings: { verifySsl: { inherit: true } }
    })
    expect(serializeRequest(state)).not.toContain('@settings')
  })

  it('includes only overridden fields', () => {
    const state = makeState({
      method: 'GET',
      url: 'https://api.com',
      settings: {
        verifySsl: { inherit: false, value: false },
        maxRedirects: { inherit: false, value: 2 },
        followRedirects: { inherit: true }
      }
    })
    const out = serializeRequest(state)
    expect(out).toContain('# @settings')
    expect(out).toContain('# verifySsl: false')
    expect(out).toContain('# maxRedirects: 2')
    expect(out).not.toContain('# followRedirects')
    expect(out).toContain('# @end-settings')
  })
})
