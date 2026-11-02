import { describe, it, expect } from 'vitest'
import { ASCII_GLYPHS, UNICODE_GLYPHS, selectGlyphs } from './glyphs'

describe('selectGlyphs', () => {
  it('returns Unicode glyphs by default', () => {
    expect(selectGlyphs(false)).toBe(UNICODE_GLYPHS)
    expect(UNICODE_GLYPHS.pass).toBe('✓')
    expect(UNICODE_GLYPHS.bullet).toBe('▶')
  })
  it('returns ASCII glyphs when asked', () => {
    expect(selectGlyphs(true)).toBe(ASCII_GLYPHS)
    expect(ASCII_GLYPHS.pass).toBe('[OK]')
    expect(ASCII_GLYPHS.fail).toBe('[FAIL]')
    expect(ASCII_GLYPHS.arrowOut).toBe('->')
  })
})
