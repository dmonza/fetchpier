import { describe, expect, it } from 'vitest'
import {
  composite,
  contrastRatio,
  deltaE,
  ensureContrast,
  formatRgba,
  hexToOklch,
  isInGamut,
  oklchToHex,
  parseColor,
  relativeLuminance
} from './color'

describe('palette color math', () => {
  it('round-trips sRGB hex through the perceptual space without drift', () => {
    for (const hex of [
      '#eef0f5',
      '#0b1020',
      '#6366f1',
      '#ffffff',
      '#000000',
      '#b45309',
      '#2a3661'
    ]) {
      expect(oklchToHex(hexToOklch(hex))).toBe(hex)
    }
  })

  it('reports perceptual coordinates in the expected ranges', () => {
    const white = hexToOklch('#ffffff')
    expect(white.l).toBeCloseTo(1, 3)
    expect(white.c).toBeLessThan(0.0005)
    const indigo = hexToOklch('#6366f1')
    expect(indigo.l).toBeCloseTo(0.585, 2)
    expect(indigo.c).toBeCloseTo(0.204, 2)
    expect(indigo.h).toBeGreaterThan(270)
    expect(indigo.h).toBeLessThan(285)
  })

  it('computes WCAG relative luminance and contrast ratios', () => {
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5)
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5)
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5)
    // Values measured during the requirement analysis.
    expect(contrastRatio('#ffffff', '#6366f1')).toBeCloseTo(4.47, 2)
    expect(contrastRatio('#a3aec2', '#ffffff')).toBeCloseTo(2.24, 2)
    // Symmetric.
    expect(contrastRatio('#6366f1', '#ffffff')).toBe(contrastRatio('#ffffff', '#6366f1'))
  })

  it('measures perceptual distance', () => {
    expect(deltaE('#6366f1', '#6366f1')).toBe(0)
    expect(deltaE('#000000', '#ffffff')).toBeCloseTo(1, 2)
    expect(deltaE('#dce2ed', '#e9e9fd')).toBeGreaterThan(0.02)
  })

  it('maps out-of-gamut colours into sRGB keeping lightness and hue', () => {
    const wanted = { l: 0.585, c: 0.3, h: 100 } // far too saturated for a yellow at this lightness
    expect(isInGamut(wanted)).toBe(false)
    const hex = oklchToHex(wanted)
    const got = hexToOklch(hex)
    expect(got.l).toBeCloseTo(0.585, 2)
    expect(Math.abs(got.h - 100)).toBeLessThan(3)
    expect(got.c).toBeLessThan(0.3)
  })

  it('clamps lightness outside the representable range', () => {
    expect(oklchToHex({ l: 1.4, c: 0, h: 0 })).toBe('#ffffff')
    expect(oklchToHex({ l: -0.2, c: 0, h: 0 })).toBe('#000000')
  })

  it('parses and formats hex and rgba colours', () => {
    expect(parseColor('#6366F1')).toEqual({ rgb: [99, 102, 241], alpha: 1 })
    expect(parseColor('rgba(99, 102, 241, 0.14)')).toEqual({ rgb: [99, 102, 241], alpha: 0.14 })
    expect(parseColor('nope')).toBeNull()
    expect(parseColor('#12345')).toBeNull()
    expect(formatRgba([99, 102, 241], 0.14)).toBe('rgba(99, 102, 241, 0.14)')
  })

  it('composites a translucent colour over an opaque background', () => {
    expect(composite('rgba(98, 101, 240, 0.14)', '#ffffff')).toBe('#e9e9fd')
    expect(composite('#123456', '#ffffff')).toBe('#123456')
    expect(composite('rgba(0, 0, 0, 0)', '#abcdef')).toBe('#abcdef')
  })
})

describe('ensureContrast', () => {
  it('leaves a colour that already meets the target untouched', () => {
    expect(ensureContrast('#0f172a', ['#ffffff'], 4.5, -1)).toBe('#0f172a')
  })

  it('moves only lightness, in the given direction, until the target is met', () => {
    const fixed = ensureContrast('#b45309', ['#dce2ed'], 4.5, -1)
    expect(contrastRatio(fixed, '#dce2ed')).toBeGreaterThanOrEqual(4.5)
    const a = hexToOklch('#b45309')
    const b = hexToOklch(fixed)
    expect(b.l).toBeLessThan(a.l)
    expect(Math.abs(b.h - a.h)).toBeLessThan(3)
  })

  it('falls back to whichever of black and white contrasts best when the target is out of reach', () => {
    // Nothing reaches 21:1 against a mid grey; black (4.69) beats white (4.48).
    expect(ensureContrast('#777777', ['#777777'], 21, 1)).toBe('#000000')
    expect(ensureContrast('#777777', ['#777777'], 21, -1)).toBe('#000000')
    // Against a dark surface, white wins.
    expect(ensureContrast('#202020', ['#101010'], 30, -1)).toBe('#ffffff')
  })
})
