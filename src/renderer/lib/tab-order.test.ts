import { describe, it, expect } from 'vitest'
import {
  regroup,
  pinTab,
  unpinTab,
  reorderClamped,
  closeRightIds,
  closeLeftIds,
  closeOthersIds,
  closeAllIds,
  nextInOrder,
  type OrderedTab
} from './tab-order'

/** Build a tab list from a compact spec: `'a'` permanent, `'b*'` pinned, `'c~'` preview. */
function tabs(...specs: string[]): OrderedTab[] {
  return specs.map((s) => ({
    id: s.replace(/[*~]/g, ''),
    mode: s.includes('*') ? 'pinned' : s.includes('~') ? 'preview' : 'permanent'
  }))
}

const ids = (list: OrderedTab[]): string[] => list.map((t) => t.id)

describe('regroup', () => {
  it('moves pinned tabs to the front, preserving relative order within each group', () => {
    expect(ids(regroup(tabs('a', 'b*', 'c', 'd*')))).toEqual(['b', 'd', 'a', 'c'])
  })

  it('is idempotent on an already-grouped list', () => {
    const grouped = tabs('b*', 'd*', 'a', 'c')
    expect(ids(regroup(grouped))).toEqual(['b', 'd', 'a', 'c'])
  })
})

describe('pinTab', () => {
  it('pins to the end of the pinned group and promotes out of preview', () => {
    const result = pinTab(tabs('p*', 'a', 'b~'), 'b')
    expect(ids(result)).toEqual(['p', 'b', 'a'])
    // 'b' started as a preview; pinning it sets mode 'pinned' (never both).
    expect(result.find((t) => t.id === 'b')?.mode).toBe('pinned')
  })

  it('is a no-op for an unknown id', () => {
    const input = tabs('a', 'b')
    expect(pinTab(input, 'zzz')).toBe(input)
  })
})

describe('unpinTab', () => {
  it('unpins to the front of the unpinned group', () => {
    // p1,p2 pinned; a,b unpinned. Unpinning p2 lands it before a.
    expect(ids(unpinTab(tabs('p1*', 'p2*', 'a', 'b'), 'p2'))).toEqual(['p1', 'p2', 'a', 'b'])
  })

  it('places a sole unpinned tab ahead of the rest', () => {
    expect(ids(unpinTab(tabs('p1*', 'p2*', 'a', 'b'), 'p1'))).toEqual(['p2', 'p1', 'a', 'b'])
  })
})

describe('reorderClamped', () => {
  it('reorders within the unpinned group', () => {
    expect(ids(reorderClamped(tabs('a', 'b', 'c'), 'c', 'a'))).toEqual(['c', 'a', 'b'])
  })

  it('reorders within the pinned group', () => {
    expect(ids(reorderClamped(tabs('p1*', 'p2*', 'a'), 'p2', 'p1'))).toEqual(['p2', 'p1', 'a'])
  })

  it('clamps a cross-boundary drag (pinned ↔ unpinned) to a no-op', () => {
    const input = tabs('p*', 'a', 'b')
    expect(reorderClamped(input, 'a', 'p')).toBe(input)
    expect(reorderClamped(input, 'p', 'b')).toBe(input)
  })
})

describe('close target sets (pinned spared)', () => {
  const list = tabs('p*', 'a', 'b', 'c', 'd')

  it('closeRightIds: tabs after the target, no pinned', () => {
    expect(closeRightIds(list, 'b')).toEqual(['c', 'd'])
  })

  it('closeLeftIds: tabs before the target, no pinned', () => {
    expect(closeLeftIds(list, 'c')).toEqual(['a', 'b'])
  })

  it('closeOthersIds: everything but the target and pinned', () => {
    expect(closeOthersIds(list, 'b')).toEqual(['a', 'c', 'd'])
  })

  it('closeAllIds: everything but pinned', () => {
    expect(closeAllIds(list)).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('nextInOrder', () => {
  const list = tabs('a', 'b', 'c')

  it('moves forward with wrap', () => {
    expect(nextInOrder(list, 'c', 1)).toBe('a')
    expect(nextInOrder(list, 'a', 1)).toBe('b')
  })

  it('moves backward with wrap', () => {
    expect(nextInOrder(list, 'a', -1)).toBe('c')
  })

  it('returns the only tab when there is one, and null when empty', () => {
    expect(nextInOrder(tabs('a'), 'a', 1)).toBe('a')
    expect(nextInOrder([], null, 1)).toBeNull()
  })
})
