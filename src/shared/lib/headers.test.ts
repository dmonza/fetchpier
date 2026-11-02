import { describe, it, expect } from 'vitest'
import {
  headersToRecord,
  recordToHeaders,
  getHeader,
  getAllHeaders,
  hasHeader,
  removeHeaders,
  setHeaderUnique,
  headersToUndiciArray
} from './headers'
import type { HeaderEntry } from '../types'

const sample: HeaderEntry[] = [
  { name: 'Accept', value: 'application/json' },
  { name: 'Accept', value: 'text/html' },
  { name: 'X-One', value: '1' }
]

describe('headers helpers', () => {
  it('headersToRecord collapses duplicates last-wins', () => {
    expect(headersToRecord(sample)).toEqual({ Accept: 'text/html', 'X-One': '1' })
  })

  it('recordToHeaders lifts a map into a list in insertion order', () => {
    expect(recordToHeaders({ A: '1', B: '2' })).toEqual([
      { name: 'A', value: '1' },
      { name: 'B', value: '2' }
    ])
  })

  it('getHeader returns the first match, case-insensitively', () => {
    expect(getHeader(sample, 'accept')).toBe('application/json')
    expect(getHeader(sample, 'missing')).toBeUndefined()
  })

  it('getAllHeaders returns every match in order', () => {
    expect(getAllHeaders(sample, 'ACCEPT')).toEqual(['application/json', 'text/html'])
    expect(getAllHeaders(sample, 'x-one')).toEqual(['1'])
    expect(getAllHeaders(sample, 'none')).toEqual([])
  })

  it('hasHeader is case-insensitive', () => {
    expect(hasHeader(sample, 'x-one')).toBe(true)
    expect(hasHeader(sample, 'x-two')).toBe(false)
  })

  it('removeHeaders drops every same-name entry, leaving a new array', () => {
    const out = removeHeaders(sample, 'accept')
    expect(out).toEqual([{ name: 'X-One', value: '1' }])
    expect(sample).toHaveLength(3) // input untouched
  })

  it('setHeaderUnique replaces all same-name entries with a single appended one', () => {
    expect(setHeaderUnique(sample, 'Accept', 'text/plain')).toEqual([
      { name: 'X-One', value: '1' },
      { name: 'Accept', value: 'text/plain' }
    ])
  })

  it('setHeaderUnique appends when the name is absent', () => {
    expect(setHeaderUnique([{ name: 'A', value: '1' }], 'B', '2')).toEqual([
      { name: 'A', value: '1' },
      { name: 'B', value: '2' }
    ])
  })

  it('headersToUndiciArray flattens to positional [name, value, …] preserving duplicates', () => {
    expect(headersToUndiciArray(sample)).toEqual([
      'Accept',
      'application/json',
      'Accept',
      'text/html',
      'X-One',
      '1'
    ])
  })
})
