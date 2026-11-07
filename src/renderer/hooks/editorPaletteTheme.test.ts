/**
 * The code editor under a palette other than Original (requirement *Dynamic
 * color themes* §6.9, CA-32): the chrome takes its colours from the palette
 * tokens, syntax keeps its family's hues with lightness adjusted only where it
 * would miss 4.5:1, and nothing is recoloured with the accent.
 */
import { describe, expect, it } from 'vitest'
import { githubDarkStyle, githubLightStyle } from '@uiw/codemirror-theme-github'
import { defaultHighlightStyle } from '@codemirror/language'
import { contrastRatio, hexToOklch } from '../../shared/palette/color'
import { generatePalette } from '../../shared/palette/generate'
import { PALETTE_CHROME_SPEC, paletteHighlightSpecs } from './editorPaletteTheme'

type Spec = { color?: unknown }
const colors = (specs: readonly Spec[]): string[] =>
  specs
    .map((s) => s.color)
    .filter((c): c is string => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c))
    .map((c) => c.toLowerCase())

describe('palette chrome', () => {
  it('takes every colour from a palette token', () => {
    for (const [selector, rules] of Object.entries(PALETTE_CHROME_SPEC)) {
      for (const [prop, value] of Object.entries(rules)) {
        if (!/color|background|border/i.test(prop)) continue
        expect({ selector, prop, ok: /var\(--[a-z0-9-]+\)/.test(String(value)) }).toEqual({
          selector,
          prop,
          ok: true
        })
      }
    }
  })

  it('never paints with the accent fill itself', () => {
    expect(JSON.stringify(PALETTE_CHROME_SPEC)).not.toMatch(/var\(--primary\)/)
  })

  it('covers the parts the family otherwise colours itself', () => {
    const selectors = Object.keys(PALETTE_CHROME_SPEC).join(' ')
    for (const part of [
      '.cm-gutters',
      '.cm-activeLine',
      '.cm-selectionBackground',
      '.cm-cursor',
      '.cm-panels',
      '.cm-tooltip'
    ]) {
      expect(selectors).toContain(part)
    }
  })
})

describe('paletteHighlightSpecs', () => {
  const dim = generatePalette('light', { hue: 60, intensity: 50, surfaceTint: 90, brightness: 0 })
  const lifted = generatePalette('dark', {
    hue: 200,
    intensity: 50,
    surfaceTint: 80,
    brightness: 0
  })

  it.each([
    ['github', 'light', dim, githubLightStyle],
    ['github', 'dark', lifted, githubDarkStyle],
    ['default', 'light', dim, defaultHighlightStyle.specs],
    ['default', 'dark', lifted, defaultHighlightStyle.specs]
  ] as const)('keeps %s/%s syntax legible on the palette', (family, mode, palette, original) => {
    const specs = paletteHighlightSpecs(family, mode, palette)!
    for (const color of colors(specs)) {
      expect(contrastRatio(color, palette.background)).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(color, palette['surface-1'])).toBeGreaterThanOrEqual(4.5)
    }
    // Same tokens, same hues: only lightness moved.
    const before = colors(original as readonly Spec[])
    const after = colors(specs)
    expect(after).toHaveLength(before.length)
    after.forEach((c, i) => {
      const a = hexToOklch(before[i])
      const b = hexToOklch(c)
      if (a.c > 0.03) expect(Math.abs(((b.h - a.h + 540) % 360) - 180)).toBeLessThanOrEqual(4)
    })
  })

  it('never uses the accent for syntax', () => {
    const palette = generatePalette('light', {
      hue: 140,
      intensity: 90,
      surfaceTint: 50,
      brightness: 80
    })
    const syntax = colors(paletteHighlightSpecs('github', 'light', palette)!)
    expect(syntax).not.toContain(palette.primary)
    expect(syntax).not.toContain(palette['primary-text'])
  })

  it('leaves families it does not know unadjusted', () => {
    expect(paletteHighlightSpecs('dracula', 'dark', lifted)).toBeNull()
  })
})
