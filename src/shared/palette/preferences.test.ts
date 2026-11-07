import { describe, expect, it } from 'vitest'
import { ORIGINAL_POINTS } from './original'
import { findPreset } from './presets'
import {
  DEFAULT_APPEARANCE,
  customizeFrom,
  normalizeAppearancePalettes,
  sameAppearance,
  selectPalette,
  setCustomParams
} from './preferences'
import type { AppearancePalettes } from '../types'

const custom = { hue: 150, intensity: 70, surfaceTint: 0, brightness: 55 }
const stored = (light: unknown, dark: unknown, schemaVersion: unknown = 1): unknown => ({
  schemaVersion,
  light,
  dark
})

describe('normalizeAppearancePalettes (CA-30)', () => {
  it.each([
    ['absent', undefined],
    ['null', null],
    ['not an object', 'ocean'],
    ['an array', []],
    ['an unknown schema version', stored({ selected: 'ocean' }, { selected: 'forest' }, 2)],
    ['a missing schema version', { light: { selected: 'ocean' }, dark: { selected: 'forest' } }]
  ])('treats %s as Original in both modes', (_label, raw) => {
    expect(normalizeAppearancePalettes(raw)).toEqual(DEFAULT_APPEARANCE)
  })

  it('keeps valid choices and Custom values', () => {
    const raw = stored({ selected: 'ocean', custom }, { selected: 'custom', custom })
    expect(normalizeAppearancePalettes(raw)).toEqual(raw)
  })

  it('falls back to Original only for the mode with an unknown preset', () => {
    const got = normalizeAppearancePalettes(stored({ selected: 'sunset' }, { selected: 'forest' }))
    expect(got.light).toEqual({ selected: 'original' })
    expect(got.dark).toEqual({ selected: 'forest' })
  })

  it('rejects a preset of the other mode', () => {
    const got = normalizeAppearancePalettes(stored({ selected: 'graphite' }, { selected: 'paper' }))
    expect(got.light.selected).toBe('original')
    expect(got.dark.selected).toBe('original')
  })

  it('keeps a valid Custom block when the selection is invalid', () => {
    const got = normalizeAppearancePalettes(
      stored({ selected: 42, custom }, { selected: 'original' })
    )
    expect(got.light).toEqual({ selected: 'original', custom })
  })

  it('falls back to Original when Custom is selected without a valid Custom block', () => {
    const got = normalizeAppearancePalettes(
      stored({ selected: 'custom' }, { selected: 'custom', custom: { hue: 1 } })
    )
    expect(got.light).toEqual({ selected: 'original' })
    expect(got.dark).toEqual({ selected: 'original' })
  })

  it('treats a Custom block with a non-numeric field as absent', () => {
    const got = normalizeAppearancePalettes(
      stored({ selected: 'ocean', custom: { ...custom, hue: 'blue' } }, { selected: 'original' })
    )
    expect(got.light).toEqual({ selected: 'ocean' })
  })

  it('clamps out-of-range values and rounds fractional ones', () => {
    const got = normalizeAppearancePalettes(
      stored(
        {
          selected: 'custom',
          custom: { hue: 400, intensity: -5, surfaceTint: 33.6, brightness: 1000 }
        },
        { selected: 'original' }
      )
    )
    expect(got.light.custom).toEqual({ hue: 360, intensity: 0, surfaceTint: 34, brightness: 100 })
  })

  it('treats a non-object mode as Original for that mode only', () => {
    const got = normalizeAppearancePalettes(stored('ocean', { selected: 'forest', custom }))
    expect(got.light).toEqual({ selected: 'original' })
    expect(got.dark).toEqual({ selected: 'forest', custom })
  })

  it('does not mutate its input', () => {
    const raw = stored(
      { selected: 'custom', custom: { ...custom, hue: 999 } },
      { selected: 'original' }
    )
    const copy = JSON.parse(JSON.stringify(raw))
    normalizeAppearancePalettes(raw)
    expect(raw).toEqual(copy)
  })
})

describe('preference updates', () => {
  const base: AppearancePalettes = {
    schemaVersion: 1,
    light: { selected: 'ocean', custom },
    dark: { selected: 'graphite' }
  }

  it('never changes the other mode (CA-06)', () => {
    for (const next of [
      selectPalette(base, 'light', 'original'),
      selectPalette(base, 'light', 'custom'),
      setCustomParams(base, 'light', { hue: 10, intensity: 10, surfaceTint: 10, brightness: 10 }),
      customizeFrom(base, 'light', 'forest')
    ]) {
      expect(next.dark).toEqual(base.dark)
    }
  })

  it('keeps the Custom values when a preset or Original is selected (CA-07)', () => {
    const toPreset = selectPalette(base, 'light', 'forest')
    expect(toPreset.light).toEqual({ selected: 'forest', custom })
    const back = selectPalette(toPreset, 'light', 'custom')
    expect(back.light).toEqual({ selected: 'custom', custom })
  })

  it('starts a never-customized mode from the selected preset (CA-25)', () => {
    const next = selectPalette(base, 'dark', 'custom')
    expect(next.dark).toEqual({
      selected: 'custom',
      custom: findPreset('dark', 'graphite')!.params
    })
  })

  it('starts a never-customized mode from the Original point when Original is selected', () => {
    const next = selectPalette(DEFAULT_APPEARANCE, 'dark', 'custom')
    expect(next.dark).toEqual({ selected: 'custom', custom: ORIGINAL_POINTS.dark })
  })

  it('copies a preset into Custom and selects it (CA-24)', () => {
    const next = customizeFrom(base, 'light', 'forest')
    expect(next.light).toEqual({
      selected: 'custom',
      custom: findPreset('light', 'forest')!.params
    })
    expect(customizeFrom(base, 'light', 'original').light.custom).toEqual(ORIGINAL_POINTS.light)
  })

  it('clamps Custom values on write', () => {
    const next = setCustomParams(base, 'light', {
      hue: -3,
      intensity: 101.4,
      surfaceTint: 50,
      brightness: 7.5
    })
    expect(next.light).toEqual({
      selected: 'custom',
      custom: { hue: 0, intensity: 100, surfaceTint: 50, brightness: 8 }
    })
  })

  it('ignores an unknown selection', () => {
    expect(selectPalette(base, 'light', 'graphite')).toEqual(base)
  })

  it('does not mutate the previous preferences', () => {
    const copy = JSON.parse(JSON.stringify(base))
    selectPalette(base, 'light', 'forest')
    setCustomParams(base, 'light', custom)
    customizeFrom(base, 'dark', 'ocean')
    expect(base).toEqual(copy)
  })

  it('compares preferences by value', () => {
    expect(sameAppearance(base, JSON.parse(JSON.stringify(base)))).toBe(true)
    expect(sameAppearance(base, selectPalette(base, 'light', 'forest'))).toBe(false)
  })
})
