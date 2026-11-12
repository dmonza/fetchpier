import { describe, expect, it } from 'vitest'
import { safeClone } from './safe-clone'

describe('safeClone — arrays', () => {
  it('keeps the holes of a sparse array instead of filling every index', () => {
    const sparse: unknown[] = []
    sparse[5] = 'x'
    const out = safeClone(sparse) as unknown[]
    expect(out).toHaveLength(6)
    expect(0 in out).toBe(false)
    expect(out[5]).toBe('x')
  })

  it('clones an array-like proxy that exposes no Array methods (BLD-01)', () => {
    const backing = [{ name: 'a' }, { name: 'b' }]
    const proxy = new Proxy(backing, {
      get(target, prop) {
        if (prop === 'map' || prop === 'forEach') return undefined
        return Reflect.get(target, prop)
      }
    })
    expect(safeClone(proxy)).toEqual([{ name: 'a' }, { name: 'b' }])
  })
})
