import { describe, it, expect } from 'vitest'
import { bumpMru, pruneMru, mruCycle } from './tab-mru'

describe('bumpMru', () => {
  it('moves the id to the front and de-duplicates', () => {
    expect(bumpMru(['b', 'a', 'c'], 'c')).toEqual(['c', 'b', 'a'])
    expect(bumpMru(['a', 'b'], 'x')).toEqual(['x', 'a', 'b'])
  })

  it('is a no-op for null/undefined', () => {
    expect(bumpMru(['a'], null)).toEqual(['a'])
    expect(bumpMru(['a'], undefined)).toEqual(['a'])
  })
})

describe('pruneMru', () => {
  it('keeps only the surviving ids, in order', () => {
    expect(pruneMru(['c', 'b', 'a'], new Set(['a', 'c']))).toEqual(['c', 'a'])
  })
})

describe('mruCycle', () => {
  // Tabs activated A, B, C → MRU snapshot ['c','b','a'] (C most recent / active).
  const snapshot = ['c', 'b', 'a']

  it('first Ctrl+Tab (steps=1) lands on the previously-used tab', () => {
    expect(mruCycle(snapshot, 1)).toBe('b')
  })

  it('walks further back toward older tabs and wraps', () => {
    expect(mruCycle(snapshot, 2)).toBe('a')
    expect(mruCycle(snapshot, 3)).toBe('c') // wrap back to the anchor
  })

  it('Ctrl+Shift+Tab (negative steps) walks toward more recent and wraps', () => {
    expect(mruCycle(snapshot, -1)).toBe('a')
  })

  it('returns null for an empty snapshot', () => {
    expect(mruCycle([], 1)).toBeNull()
  })
})
