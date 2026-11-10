import { describe, it, expect } from 'vitest'
import { classNames, cn } from './utils'

describe('classNames', () => {
  it('returns an empty string for no input', () => {
    expect(classNames()).toBe('')
  })

  it('joins strings with single spaces and skips empty ones', () => {
    expect(classNames('a', '', 'b')).toBe('a b')
  })

  it('skips falsy values', () => {
    expect(classNames('a', false, null, undefined, 0, 'b')).toBe('a b')
  })

  it('keeps non-zero numbers', () => {
    expect(classNames(1, 'a', 2)).toBe('1 a 2')
  })

  it('includes the keys of an object whose values are truthy', () => {
    expect(classNames({ a: true, b: false, c: 1, d: 0, e: null, f: 'yes' })).toBe('a c f')
  })

  it('flattens nested arrays', () => {
    expect(classNames(['a', ['b', [false, 'c']]], 'd')).toBe('a b c d')
  })

  it('mixes every input shape in argument order', () => {
    const active = true
    expect(classNames('base', active && 'on', { off: !active }, ['x', { y: true }])).toBe(
      'base on x y'
    )
  })

  it('ignores true and other non-class primitives', () => {
    expect(classNames('a', true, 'b')).toBe('a b')
  })
})

describe('cn', () => {
  it('lets a later Tailwind class win a conflict', () => {
    expect(cn('px-2 py-1', 'px-4')).toBe('py-1 px-4')
  })

  it('resolves conflicts across conditional inputs', () => {
    const muted = false
    expect(cn('text-sm', { 'text-xs': true }, ['bg-primary'], muted && 'bg-muted')).toBe(
      'text-xs bg-primary'
    )
  })

  it('returns an empty string when nothing applies', () => {
    expect(cn(false, null, undefined)).toBe('')
  })
})
