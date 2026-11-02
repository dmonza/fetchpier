import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { assertSafeIdentifier, resolveInsideWorkspace } from './safe-path'

const WS = path.resolve('/tmp/ws')

describe('resolveInsideWorkspace', () => {
  it('joins segments inside the workspace', () => {
    const out = resolveInsideWorkspace(WS, 'requests', 'a.http')
    expect(out).toBe(path.join(WS, 'requests', 'a.http'))
  })

  it('returns the workspace root for empty segments', () => {
    expect(resolveInsideWorkspace(WS)).toBe(WS)
  })

  it('rejects ".." traversal', () => {
    expect(() => resolveInsideWorkspace(WS, '..', 'evil')).toThrow(/escapes workspace/)
  })

  it('rejects absolute paths outside the workspace', () => {
    const outsider = path.resolve('/etc/passwd')
    expect(() => resolveInsideWorkspace(WS, outsider)).toThrow(/escapes workspace/)
  })

  it('rejects a sibling whose name starts with the workspace prefix', () => {
    // path.resolve treats absolute segments as restarts; this verifies the
    // separator-suffixed prefix check refuses "<ws>-sibling".
    const sibling = WS + '-sibling'
    expect(() => resolveInsideWorkspace(WS, sibling)).toThrow(/escapes workspace/)
  })
})

describe('assertSafeIdentifier', () => {
  it('accepts simple identifiers', () => {
    expect(assertSafeIdentifier('my-env')).toBe('my-env')
    expect(assertSafeIdentifier('abc_123.json')).toBe('abc_123.json')
  })

  it('rejects empty string', () => {
    expect(() => assertSafeIdentifier('')).toThrow(/Unsafe identifier/)
  })

  it('rejects forward slash', () => {
    expect(() => assertSafeIdentifier('a/b')).toThrow(/Unsafe identifier/)
  })

  it('rejects backslash', () => {
    expect(() => assertSafeIdentifier('a\\b')).toThrow(/Unsafe identifier/)
  })

  it('rejects pure-dots segments', () => {
    expect(() => assertSafeIdentifier('..')).toThrow(/Unsafe identifier/)
    expect(() => assertSafeIdentifier('.')).toThrow(/Unsafe identifier/)
    expect(() => assertSafeIdentifier('...')).toThrow(/Unsafe identifier/)
  })

  it('rejects NUL byte', () => {
    expect(() => assertSafeIdentifier('a\0b')).toThrow(/Unsafe identifier/)
  })

  it('uses the supplied label in the error message', () => {
    expect(() => assertSafeIdentifier('a/b', 'environment id')).toThrow(/Unsafe environment id/)
  })

  it('rejects non-string inputs', () => {
    // @ts-expect-error — intentional: test runtime guard
    expect(() => assertSafeIdentifier(42)).toThrow(/Unsafe identifier/)
  })
})
