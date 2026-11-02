import { describe, it, expect } from 'vitest'
import { sanitizeName, sanitizeSegments, uniqueName } from './sanitize'

describe('sanitizeName', () => {
  it('strips forbidden characters', () => {
    expect(sanitizeName('a/b?c:d*e<f>g|h"i')).toBe('a-b-c-d-e-f-g-h-i')
  })

  it('collapses whitespace to dashes', () => {
    expect(sanitizeName('  hello   world  ')).toBe('hello-world')
  })

  it('applies fallback when empty', () => {
    expect(sanitizeName('', 'fb')).toBe('fb')
    expect(sanitizeName('???', 'fb')).toBe('fb')
  })

  it('renames Windows reserved names', () => {
    expect(sanitizeName('CON')).toBe('CON-file')
    expect(sanitizeName('com1')).toBe('com1-file')
  })

  it('rejects pure-dot segments that could traverse paths', () => {
    expect(sanitizeName('..', 'fb')).toBe('fb')
    expect(sanitizeName('...', 'fb')).toBe('fb')
    expect(sanitizeName('.', 'fb')).toBe('fb')
  })

  it('truncates very long names', () => {
    const long = 'a'.repeat(300)
    expect(sanitizeName(long).length).toBe(120)
  })
})

describe('sanitizeSegments', () => {
  it('sanitizes and drops empty segments', () => {
    expect(sanitizeSegments(['a/b', '', '?', 'ok'])).toEqual(['a-b', 'ok'])
  })
})

describe('uniqueName', () => {
  it('returns desired name when free', () => {
    const used = new Set<string>()
    expect(uniqueName('foo', used)).toBe('foo')
    expect(used.has('foo')).toBe(true)
  })

  it('adds incremental suffixes on collision', () => {
    const used = new Set<string>(['foo'])
    expect(uniqueName('foo', used)).toBe('foo-2')
    expect(uniqueName('foo', used)).toBe('foo-3')
  })
})
