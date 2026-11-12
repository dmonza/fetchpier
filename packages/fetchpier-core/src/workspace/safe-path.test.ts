import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { assertPortableName, assertSafeIdentifier, resolveInsideWorkspace } from './safe-path'

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

describe('assertPortableName', () => {
  it.each([
    'login',
    'Step 1 - login',
    'v2.1',
    'users.v2',
    'año ñandú',
    '50% off',
    'CONSOLE',
    'COM10',
    'nulls',
    '.hidden-looking'
  ])('accepts %j', (name) => {
    expect(assertPortableName(name)).toBe(name)
  })

  it.each([
    ['colon', 'Step 1: login'],
    ['question mark', 'what?'],
    ['asterisk', 'a*b'],
    ['less-than', 'a<b'],
    ['greater-than', 'a>b'],
    ['double quote', 'say "hi"'],
    ['pipe', 'a|b'],
    ['forward slash', 'a/b'],
    ['backslash', 'a\\b'],
    ['NUL', 'a\0b'],
    ['tab', 'a\tb'],
    ['unit separator (0x1F)', 'a\x1fb'],
    ['trailing dot', 'v2.'],
    ['trailing space', 'v3 '],
    ['pure dots', '..'],
    ['empty', ''],
    ['device name', 'CON'],
    ['device name, lower case', 'nul'],
    ['device name with an extension', 'aux.json'],
    ['numbered device name', 'COM1'],
    ['numbered device name with an extension', 'lpt9.backup']
  ])('rejects the %s case with INVALID_ENTRY_NAME', (_label, name) => {
    expect(() => assertPortableName(name)).toThrow(/^INVALID_ENTRY_NAME:/)
  })
})
