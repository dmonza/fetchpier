import { describe, it, expect } from 'vitest'
import type { HistoryEntry } from '../../../shared/types'
import { historyRepeatRequest, historyViewRequest } from './history-request'
import { buildHttpRequestPayload } from '../request/build-send-payload'

function entry(url: string, overrides: Partial<HistoryEntry['request']> = {}): HistoryEntry {
  return {
    id: 'run-1',
    timestamp: '2026-11-11T10:00:00.000Z',
    sourceFile: null,
    request: { method: 'GET', url, headers: { Accept: 'application/json' }, ...overrides },
    response: { status: 200, statusText: 'OK', headers: {}, body: '', timingMs: 1, sizeBytes: 0 }
  }
}

const shape = (r: {
  url: string
  params: { key: string; value: string; valueless?: boolean }[]
}) => ({
  url: r.url,
  params: r.params.map((p) => [p.key, p.value, p.valueless === true])
})

// The recorded URL carries the query; both history surfaces put it back in the
// Params grid, as the editor does for any request it opens.
describe.each([
  ['Open (read-only tab)', historyViewRequest],
  ['Repeat', historyRepeatRequest]
])('%s', (_label, build) => {
  it('splits the recorded URL into base and parameters', () => {
    expect(shape(build(entry('{{baseUrl}}/users?page=2&q=a%20b&token={{token}}&wsdl')))).toEqual({
      url: '{{baseUrl}}/users',
      params: [
        ['page', '2', false],
        ['q', 'a b', false],
        ['token', '{{token}}', false],
        ['wsdl', '', true]
      ]
    })
  })

  it('keeps a URL without a query as the base, with no parameters', () => {
    expect(shape(build(entry('{{baseUrl}}/users')))).toEqual({
      url: '{{baseUrl}}/users',
      params: []
    })
  })

  it('keeps the method and the recorded headers', () => {
    const r = build(entry('{{baseUrl}}/users?page=2', { method: 'DELETE' }))
    expect(r.method).toBe('DELETE')
    expect(r.headers.map((h) => [h.key, h.value])).toEqual([['Accept', 'application/json']])
  })
})

describe('Repeat — the send carries the recorded query', () => {
  it('hands the engine the base URL and the parameters, tokens verbatim', () => {
    const payload = buildHttpRequestPayload(
      historyRepeatRequest(entry('{{baseUrl}}/users?page=2&token={{token}}')),
      {}
    )
    expect(payload.url).toBe('{{baseUrl}}/users')
    expect(payload.params?.map((p) => [p.key, p.value])).toEqual([
      ['page', '2'],
      ['token', '{{token}}']
    ])
  })
})

describe('Open — read-only body hydration (moved unchanged)', () => {
  it('reads a form body into fields', () => {
    const r = historyViewRequest(
      entry('{{baseUrl}}/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'user=juan&pass=x%20y'
      })
    )
    expect(r.bodyType).toBe('x-www-form-urlencoded')
    expect(r.formFields.map((f) => [f.key, f.value])).toEqual([
      ['user', 'juan'],
      ['pass', 'x y']
    ])
  })

  it('opens a form body whose literal holds a bare `%` (raw text kept), reading `+` as a space', () => {
    const r = historyViewRequest(
      entry('{{baseUrl}}/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'discount=10%&scope=read+write&id={{id}}'
      })
    )
    expect(r.bodyType).toBe('x-www-form-urlencoded')
    expect(r.formFields.map((f) => [f.key, f.value])).toEqual([
      ['discount', '10%'],
      ['scope', 'read write'],
      ['id', '{{id}}']
    ])
  })

  it('reads a JSON body as raw json', () => {
    const r = historyViewRequest(
      entry('{{baseUrl}}/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"a":1}'
      })
    )
    expect([r.bodyType, r.rawSubtype, r.body]).toEqual(['raw', 'json', '{"a":1}'])
  })
})
