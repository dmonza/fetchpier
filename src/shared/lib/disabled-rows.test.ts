import { describe, it, expect } from 'vitest'
import {
  serializeDisabledRow,
  parseDisabledRow,
  reinterleaveDisabled,
  type DisabledRow
} from './disabled-rows'
import type { KeyValuePair } from '../types'

describe('disabled-rows grammar', () => {
  it('round-trips a header verbatim', () => {
    const row: DisabledRow = { kind: 'header', pos: 2, key: 'X-Custom', value: ' spaced value ' }
    const line = serializeDisabledRow(row)
    expect(line).toBe('# @disabled header 2 X-Custom:  spaced value ')
    expect(parseDisabledRow(line)).toEqual(row)
  })

  it('percent-encodes param/field values with token passthrough', () => {
    const row: DisabledRow = { kind: 'param', pos: 0, key: 'q', value: 'a/b&c {{tok}}' }
    const line = serializeDisabledRow(row)
    expect(line).toBe('# @disabled param 0 q=a%2Fb%26c%20{{tok}}')
    expect(parseDisabledRow(line)).toEqual(row)
  })

  it('reads as an inert comment to a parser that does not know it', () => {
    expect(serializeDisabledRow({ kind: 'field', pos: 1, key: 'k', value: 'v' })).toMatch(/^# /)
  })

  it('returns null for a non-@disabled line', () => {
    expect(parseDisabledRow('# a normal comment')).toBeNull()
    expect(parseDisabledRow('X-Header: value')).toBeNull()
  })

  it('re-interleaves disabled rows in ascending position, clamping out-of-range', () => {
    const enabled: KeyValuePair[] = [
      { id: 'a', key: 'A', value: '1', enabled: true },
      { id: 'c', key: 'C', value: '3', enabled: true }
    ]
    const disabled: DisabledRow[] = [
      { kind: 'header', pos: 1, key: 'B', value: '2' },
      { kind: 'header', pos: 99, key: 'D', value: '4' } // out of range → appended
    ]
    let n = 0
    const merged = reinterleaveDisabled(enabled, disabled, (r) => ({
      id: `d-${n++}`,
      key: r.key,
      value: r.value,
      enabled: false
    }))
    expect(merged.map((r) => [r.key, r.enabled])).toEqual([
      ['A', true],
      ['B', false],
      ['C', true],
      ['D', false]
    ])
  })
})

// ── Value-less query parameters (REQ-0124) ──────────────────────────────────
// A disabled flag parameter must round-trip without gaining an `=`, or toggling
// it off and back on across a save reintroduces the very defect this fixes.

describe('disabled-rows grammar — value-less params (REQ-0124)', () => {
  it('serializes a value-less param as a bare key and reads it back flagged', () => {
    const row: DisabledRow = { kind: 'param', pos: 2, key: 'wsdl', value: '', valueless: true }
    const line = serializeDisabledRow(row)
    expect(line).toBe('# @disabled param 2 wsdl')
    expect(parseDisabledRow(line)).toEqual(row)
  })

  it('keeps an empty-valued param distinct from a value-less one', () => {
    const line = serializeDisabledRow({ kind: 'param', pos: 3, key: 'wsdl', value: '' })
    expect(line).toBe('# @disabled param 3 wsdl=')
    const parsed = parseDisabledRow(line)
    expect(parsed).toMatchObject({ kind: 'param', pos: 3, key: 'wsdl', value: '' })
    expect(parsed?.valueless).toBeFalsy()
  })

  it('still percent-encodes the key of a value-less param', () => {
    const row: DisabledRow = { kind: 'param', pos: 0, key: 'a b', value: '', valueless: true }
    expect(serializeDisabledRow(row)).toBe('# @disabled param 0 a%20b')
    expect(parseDisabledRow('# @disabled param 0 a%20b')).toEqual(row)
  })

  it('never flags a form field — the distinction is query-only (out of scope)', () => {
    const parsed = parseDisabledRow('# @disabled field 1 k')
    expect(parsed).toMatchObject({ kind: 'field', key: 'k', value: '' })
    expect(parsed?.valueless).toBeFalsy()
    // A field with an empty value still serializes with its `=`, unchanged.
    expect(serializeDisabledRow({ kind: 'field', pos: 1, key: 'k', value: '' })).toBe(
      '# @disabled field 1 k='
    )
  })
})
