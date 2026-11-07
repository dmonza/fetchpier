import { describe, expect, it } from 'vitest'
import { generatePalette } from './generate'
import { findPreset } from './presets'
import { resolveModePalettes } from './resolve'

describe('resolveModePalettes', () => {
  it('applies no overrides for Original, so the built-in stylesheet shows', () => {
    expect(
      resolveModePalettes({
        schemaVersion: 1,
        light: { selected: 'original' },
        dark: { selected: 'original' }
      })
    ).toEqual({ light: null, dark: null })
  })

  it('generates each mode from its own choice', () => {
    const custom = { hue: 150, intensity: 70, surfaceTint: 20, brightness: 60 }
    const got = resolveModePalettes({
      schemaVersion: 1,
      light: { selected: 'ocean', custom },
      dark: { selected: 'custom', custom }
    })
    expect(got.light).toEqual(generatePalette('light', findPreset('light', 'ocean')!.params))
    expect(got.dark).toEqual(generatePalette('dark', custom))
  })

  it('normalizes what it is given', () => {
    expect(resolveModePalettes({ schemaVersion: 7 } as never)).toEqual({ light: null, dark: null })
  })
})
