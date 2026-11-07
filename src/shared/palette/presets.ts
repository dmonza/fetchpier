/**
 * The built-in preset palettes. Each is a named point of the Custom space —
 * four control values run through the same generator — so presets are coherent
 * and legible by construction and "Customize" can copy them losslessly.
 *
 * Ids are stable and never reused: they are what the settings file stores.
 * The values were chosen to match each preset's identity (requirement *Dynamic
 * color themes* §6.2) and are subject to the owner's visual review.
 */
import type { CustomPaletteParams, PaletteMode } from '../types'

export interface PalettePreset {
  id: string
  mode: PaletteMode
  /** i18n key of the display name. */
  nameKey: string
  params: CustomPaletteParams
}

const preset = (mode: PaletteMode, id: string, params: CustomPaletteParams): PalettePreset => ({
  id,
  mode,
  nameKey: `settings.appearance.presets.${id}`,
  params
})

export const PALETTE_PRESETS: readonly PalettePreset[] = [
  // Warm, paper-like surfaces with a sober warm accent.
  preset('light', 'paper', { hue: 65, intensity: 50, surfaceTint: 85, brightness: 88 }),
  // Blue-green accent, lightly tinted surfaces.
  preset('light', 'ocean', { hue: 215, intensity: 75, surfaceTint: 65, brightness: 100 }),
  // Green accent, lightly tinted surfaces.
  preset('light', 'forest', { hue: 150, intensity: 65, surfaceTint: 65, brightness: 96 }),
  // Neutral grey surfaces with the Original's indigo accent.
  preset('dark', 'graphite', { hue: 277, intensity: 80, surfaceTint: 0, brightness: 55 }),
  preset('dark', 'ocean', { hue: 220, intensity: 75, surfaceTint: 55, brightness: 50 }),
  preset('dark', 'forest', { hue: 155, intensity: 65, surfaceTint: 45, brightness: 55 })
]

/** Preset ids valid for `mode` (Original and Custom are not presets). */
export function presetIdsFor(mode: PaletteMode): string[] {
  return PALETTE_PRESETS.filter((p) => p.mode === mode).map((p) => p.id)
}

export function findPreset(mode: PaletteMode, id: string): PalettePreset | undefined {
  return PALETTE_PRESETS.find((p) => p.mode === mode && p.id === id)
}
