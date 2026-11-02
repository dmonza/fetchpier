import { describe, it, expect } from 'vitest'
import { applyOrder } from './sortable-context'

interface Item {
  id: string
  v: number
}

const items: Item[] = [
  { id: 'a', v: 1 },
  { id: 'b', v: 2 },
  { id: 'c', v: 3 }
]

describe('applyOrder', () => {
  it('reorders items to match the given id order', () => {
    const out = applyOrder(items, ['c', 'a', 'b'], (i) => i.id)
    expect(out.map((i) => i.id)).toEqual(['c', 'a', 'b'])
  })

  it('drops items whose id is absent from the new order', () => {
    const out = applyOrder(items, ['b', 'a'], (i) => i.id)
    expect(out.map((i) => i.id)).toEqual(['b', 'a'])
  })

  it('skips ids that do not correspond to any item', () => {
    const out = applyOrder(items, ['c', 'ghost', 'a'], (i) => i.id)
    expect(out.map((i) => i.id)).toEqual(['c', 'a'])
  })

  it('returns an empty array for an empty order', () => {
    expect(applyOrder(items, [], (i) => i.id)).toEqual([])
  })

  it('preserves the matched item references', () => {
    const out = applyOrder(items, ['b'], (i) => i.id)
    expect(out[0]).toBe(items[1])
  })
})
