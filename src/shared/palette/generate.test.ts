/**
 * The palette generator (requirement *Dynamic color themes* §6.4.3).
 *
 * The grid is the one the requirement names: 0, 25, 50, 75 and 100 for each
 * control and every 30° of Hue, in both modes (1500 palettes per mode). It is
 * split per hue so each block stays well inside the test timeout.
 */
import { describe, expect, it } from 'vitest'
import { contrastRatio, hexToOklch, parseColor, relativeLuminance } from './color'
import { generatePalette } from './generate'
import { ORIGINAL_PALETTES, ORIGINAL_POINTS, PALETTE_TOKENS } from './original'
import { PALETTE_PRESETS } from './presets'
import { CONTRAST_RULES, FIELD_TEXT, STATUS_TEXT, paletteViolations } from './rules'
import type { CustomPaletteParams, PaletteMode, PaletteTokens } from '../types'

const MODES: PaletteMode[] = ['light', 'dark']
const STEPS = [0, 25, 50, 75, 100]
const HUES = Array.from({ length: 12 }, (_, i) => i * 30)

const SURFACES = [
  'canvas',
  'background',
  'surface-1',
  'surface-2',
  'surface-3',
  'card',
  'popover',
  'sidebar',
  'surface-code',
  'secondary',
  'muted',
  'accent'
]

/** Levels of the depth ramp, deepest first in Dark. */
const DEPTH = ['canvas', 'background', 'surface-1', 'surface-2', 'surface-3']

function gridFor(hue: number): CustomPaletteParams[] {
  const out: CustomPaletteParams[] = []
  for (const intensity of STEPS)
    for (const surfaceTint of STEPS)
      for (const brightness of STEPS) out.push({ hue, intensity, surfaceTint, brightness })
  return out
}

const L = (hex: string): number => hexToOklch(hex).l

describe.each(MODES)('generatePalette — %s', (mode) => {
  const original = ORIGINAL_PALETTES[mode]

  it('reproduces the Original exactly at the Original point (CA-02)', () => {
    expect(generatePalette(mode, ORIGINAL_POINTS[mode])).toEqual(original)
  })

  it('is deterministic and does not mutate its input (CA-10)', () => {
    const params = { hue: 123, intensity: 61, surfaceTint: 33, brightness: 17 }
    const copy = { ...params }
    expect(generatePalette(mode, params)).toEqual(generatePalette(mode, params))
    expect(params).toEqual(copy)
  })

  it('clamps out-of-range and fractional controls instead of failing', () => {
    const wild = generatePalette(mode, {
      hue: 725.6,
      intensity: -40,
      surfaceTint: 250,
      brightness: 1e9
    })
    const tame = generatePalette(mode, {
      hue: 360,
      intensity: 0,
      surfaceTint: 100,
      brightness: 100
    })
    expect(wild).toEqual(tame)
  })

  it('treats hue 360 as hue 0', () => {
    const at0 = generatePalette(mode, { hue: 0, intensity: 70, surfaceTint: 60, brightness: 40 })
    const at360 = generatePalette(mode, {
      hue: 360,
      intensity: 70,
      surfaceTint: 60,
      brightness: 40
    })
    expect(at360).toEqual(at0)
  })

  describe.each(HUES)('hue %i°', (hue) => {
    const palettes = gridFor(hue).map((params) => ({
      params,
      tokens: generatePalette(mode, params)
    }))
    const label = (p: CustomPaletteParams): string => JSON.stringify(p)

    it('produces every token as a valid colour (CA-10)', () => {
      for (const { params, tokens } of palettes) {
        for (const token of PALETTE_TOKENS) {
          expect({ at: label(params), token, ok: parseColor(tokens[token]) !== null }).toEqual({
            at: label(params),
            token,
            ok: true
          })
        }
      }
    })

    it('keeps Light light and Dark dark (CA-11)', () => {
      for (const { params, tokens } of palettes) {
        for (const s of SURFACES) {
          const y = relativeLuminance(tokens[s])
          const ok = mode === 'light' ? y >= 0.45 : y <= 0.08
          expect({ at: label(params), s, y: Number(y.toFixed(3)), ok }).toMatchObject({ ok: true })
        }
        if (mode === 'light') {
          expect({
            at: label(params),
            bg: relativeLuminance(tokens.background) >= 0.6
          }).toMatchObject({
            bg: true
          })
        }
      }
    })

    // Differences are compared within 8-bit rounding: each colour is stored as
    // `#rrggbb`, which near black moves perceptual lightness by up to ~0.003.
    it('keeps the depth structure of the Original (CA-12)', () => {
      for (const { params, tokens } of palettes) {
        for (let i = 0; i < DEPTH.length; i++) {
          for (let j = i + 1; j < DEPTH.length; j++) {
            const before = L(original[DEPTH[j]]) - L(original[DEPTH[i]])
            const after = L(tokens[DEPTH[j]]) - L(tokens[DEPTH[i]])
            const ok =
              Math.sign(after) === Math.sign(before) && Math.abs(after) >= Math.abs(before) - 0.006
            expect({ at: label(params), pair: `${DEPTH[i]}/${DEPTH[j]}`, ok }).toMatchObject({
              ok: true
            })
          }
        }
      }
    })

    it('meets every contrast, ramp and selection target (CA-13, CA-36)', () => {
      for (const { params, tokens } of palettes) {
        expect({ at: label(params), violations: paletteViolations(tokens, mode) }).toEqual({
          at: label(params),
          violations: []
        })
      }
    })

    it('keeps semantic colours recognisable, adjusting lightness only when needed (CA-15)', () => {
      const semantic = [...STATUS_TEXT, ...FIELD_TEXT]
      for (const { params, tokens } of palettes) {
        for (const token of semantic) {
          const rule = CONTRAST_RULES.find((r) => r.token === token)!
          const originalPasses = rule.against.every(
            (s) => contrastRatio(original[token], tokens[s]) >= rule.target
          )
          if (originalPasses) {
            expect({ at: label(params), token, value: tokens[token] }).toEqual({
              at: label(params),
              token,
              value: original[token]
            })
          } else {
            const a = hexToOklch(original[token])
            const b = hexToOklch(tokens[token])
            const hueKept = a.c < 0.03 || Math.abs(((b.h - a.h + 540) % 360) - 180) <= 4
            expect({ at: label(params), token, hueKept }).toMatchObject({ hueKept: true })
          }
        }
      }
    })
  })

  it('keeps primary-button text legible on a light accent (CA-14)', () => {
    const tokens = generatePalette(mode, {
      hue: 100,
      intensity: 100,
      surfaceTint: 50,
      brightness: 50
    })
    expect(tokens['primary-foreground']).not.toBe('#ffffff')
    for (const fill of ['primary', 'primary-hover', 'primary-active']) {
      expect(contrastRatio(tokens['primary-foreground'], tokens[fill])).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('makes Surface tint 0 neutral and Intensity 0 grey', () => {
    const tokens = generatePalette(mode, { hue: 30, intensity: 0, surfaceTint: 0, brightness: 50 })
    for (const s of SURFACES) expect(hexToOklch(tokens[s]).c).toBeLessThan(0.004)
    expect(hexToOklch(tokens.primary).c).toBeLessThan(0.004)
  })
})

describe('preset catalog', () => {
  it('ships Paper, Ocean and Forest for Light and Graphite, Ocean and Forest for Dark', () => {
    const ids = (mode: PaletteMode): string[] =>
      PALETTE_PRESETS.filter((p) => p.mode === mode).map((p) => p.id)
    expect(ids('light')).toEqual(['paper', 'ocean', 'forest'])
    expect(ids('dark')).toEqual(['graphite', 'ocean', 'forest'])
  })

  it.each(PALETTE_PRESETS)('$mode/$id generates a compliant palette', (preset) => {
    const tokens: PaletteTokens = generatePalette(preset.mode, preset.params)
    expect(paletteViolations(tokens, preset.mode)).toEqual([])
    expect(preset.nameKey).toBe(`settings.appearance.presets.${preset.id}`)
  })

  it('makes Graphite neutral', () => {
    const graphite = PALETTE_PRESETS.find((p) => p.id === 'graphite')!
    const tokens = generatePalette('dark', graphite.params)
    for (const s of SURFACES) expect(hexToOklch(tokens[s]).c).toBeLessThan(0.004)
  })
})
