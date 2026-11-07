/**
 * Preferences → the override map in force per mode. `null` means Original: the
 * built-in stylesheet is shown and nothing is overridden.
 */
import { generatePalette } from './generate'
import { CUSTOM_ID, ORIGINAL_ID, normalizeAppearancePalettes, paramsOf } from './preferences'
import type { AppearancePalettes, ModePalettes, PaletteMode, PaletteTokens } from '../types'

function resolveMode(prefs: AppearancePalettes, mode: PaletteMode): PaletteTokens | null {
  const pref = prefs[mode]
  if (pref.selected === ORIGINAL_ID) return null
  if (pref.selected === CUSTOM_ID && !pref.custom) return null
  return generatePalette(mode, paramsOf(mode, pref))
}

export function resolveModePalettes(prefs: AppearancePalettes): ModePalettes {
  const p = normalizeAppearancePalettes(prefs)
  return { light: resolveMode(p, 'light'), dark: resolveMode(p, 'dark') }
}
