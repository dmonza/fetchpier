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
