import { describe, it, expect } from 'vitest'
import { hashString } from './hash'

describe('hashString', () => {
  it('is deterministic — same input yields the same hash', () => {
    const a = hashString('GET https://example.com\n\n')
    const b = hashString('GET https://example.com\n\n')
    expect(a).toBe(b)
  })

  it('produces a ≥64-bit value (16 lowercase hex chars)', () => {
    expect(hashString('anything')).toMatch(/^[0-9a-f]{16}$/)
    expect(hashString('')).toMatch(/^[0-9a-f]{16}$/)
  })

  it('distinguishes different inputs', () => {
    expect(hashString('a')).not.toBe(hashString('b'))
    expect(hashString('ab')).not.toBe(hashString('ba'))
    expect(hashString('value')).not.toBe(hashString('value '))
    expect(hashString('')).not.toBe(hashString('\u0000'))
  })

  it('is sensitive to a single-character change in a large input', () => {
    const base = 'x'.repeat(100_000)
    const mutated = base.slice(0, 50_000) + 'y' + base.slice(50_001)
    expect(hashString(base)).not.toBe(hashString(mutated))
  })

  it('handles unicode without throwing and stays deterministic', () => {
    const s = 'café — 日本語 — {{var}}'
    expect(hashString(s)).toBe(hashString(s))
    expect(hashString(s)).toMatch(/^[0-9a-f]{16}$/)
  })
})
