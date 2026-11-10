import { describe, it, expect } from 'vitest'
import { createColors } from './colors'

describe('createColors', () => {
  it('disables color with --no-color', () => {
    expect(createColors({ noColor: true, isTTY: true, env: {} }).level).toBe(0)
  })
  it('disables color with NO_COLOR', () => {
    expect(createColors({ isTTY: true, env: { NO_COLOR: '1' } }).level).toBe(0)
  })
  it('forces color with FORCE_COLOR even when not a TTY', () => {
    expect(createColors({ isTTY: false, env: { FORCE_COLOR: '1' } }).level).toBeGreaterThan(0)
  })
  it('FORCE_COLOR=0 does not force', () => {
    expect(createColors({ isTTY: false, env: { FORCE_COLOR: '0' } }).level).toBe(0)
  })
  it('enables color on a TTY', () => {
    expect(createColors({ isTTY: true, env: {} }).level).toBeGreaterThan(0)
  })
  it('disables color when not a TTY', () => {
    expect(createColors({ isTTY: false, env: {} }).level).toBe(0)
  })
})

describe('color output', () => {
  const on = createColors({ isTTY: true, env: {} })
  const off = createColors({ isTTY: false, env: {} })

  it.each([
    ['red', 31],
    ['green', 32],
    ['yellow', 33]
  ] as const)('wraps %s text in SGR %i and resets the foreground when enabled', (name, code) => {
    expect(on[name]('ok')).toBe(`\u001b[${code}mok\u001b[39m`)
  })

  it.each(['red', 'green', 'yellow'] as const)(
    'returns %s text unchanged when disabled',
    (name) => {
      expect(off[name]('ok')).toBe('ok')
    }
  )

  it('leaves an empty string empty even when enabled', () => {
    expect(on.red('')).toBe('')
  })
})
