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

describe('safeClone — values whose data is not enumerable (ISS-0002)', () => {
  it('does not take an object with a borrowed tag for a Date, Map or Set', () => {
    expect(safeClone({ [Symbol.toStringTag]: 'Date', a: 1 })).toEqual({ a: 1 })
    expect(safeClone({ [Symbol.toStringTag]: 'Map', a: 1 })).toEqual({ a: 1 })
    expect(safeClone({ [Symbol.toStringTag]: 'Set', a: 1 })).toEqual({ a: 1 })
  })

  it('keeps the stack as it is when no stack option is given', () => {
    const e = new Error('x')
    expect((safeClone(e) as { stack: string }).stack).toBe(e.stack)
  })

  it('passes the stack through the stack option', () => {
    const out = safeClone(new RangeError('r'), { stack: () => 'filtered' })
    expect(out).toEqual({ name: 'RangeError', message: 'r', stack: 'filtered' })
  })

  it('never copies an enumerable own stack past the stack option', () => {
    const e = new Error('x')
    Object.defineProperty(e, 'stack', { value: { raw: '/host/path' }, enumerable: true })
    expect(safeClone(e, { stack: () => 'filtered' })).toEqual({ name: 'Error', message: 'x' })
  })

  it('does not throw on an error whose message getter throws', () => {
    class Odd extends Error {
      get message(): string {
        throw new Error('getter')
      }
    }
    expect(safeClone(new Odd())).toMatchObject({ name: 'Error', message: '' })
  })

  it('truncates an error past the depth limit', () => {
    expect(safeClone({ a: { b: { c: new Error('deep') } } })).toEqual({
      a: { b: { c: { __inspect: 'truncated', kind: 'object' } } }
    })
  })
})
