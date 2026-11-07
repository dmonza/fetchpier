/**
 * The user's palette preferences: normalization of what the settings file holds
 * and the pure updates the interface applies (requirement *Dynamic color themes*
 * §5.3, §6.2, §6.3).
 *
 * Normalization is a display-level fallback: it never fails, never mutates its
 * input, and a problem in one mode never affects the other or discards a valid
 * Custom block. The caller decides whether anything is written — reading the
 * settings never rewrites the file.
 *
 * Engine-free on purpose: the renderer's eager bundle imports this module.
 */
import { ORIGINAL_POINTS } from './original'
import { findPreset, presetIdsFor } from './presets'
import type {
  AppearancePalettes,
  CustomPaletteParams,
  ModePalettePreference,
  PaletteMode
} from '../types'

export const ORIGINAL_ID = 'original'
export const CUSTOM_ID = 'custom'

export const DEFAULT_APPEARANCE: AppearancePalettes = {
  schemaVersion: 1,
  light: { selected: ORIGINAL_ID },
  dark: { selected: ORIGINAL_ID }
}

const PARAM_KEYS = ['hue', 'intensity', 'surfaceTint', 'brightness'] as const
const PARAM_MAX: Record<(typeof PARAM_KEYS)[number], number> = {
  hue: 360,
  intensity: 100,
  surfaceTint: 100,
  brightness: 100
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Integer controls within their ranges. */
export function clampCustomParams(p: CustomPaletteParams): CustomPaletteParams {
  const out = {} as CustomPaletteParams
  for (const key of PARAM_KEYS) {
    const v = p[key]
    out[key] = Number.isFinite(v) ? Math.min(PARAM_MAX[key], Math.max(0, Math.round(v))) : 0
  }
  return out
}

function normalizeCustom(raw: unknown): CustomPaletteParams | undefined {
  if (!isRecord(raw)) return undefined
  for (const key of PARAM_KEYS) {
    if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key])) return undefined
  }
  return clampCustomParams(raw as unknown as CustomPaletteParams)
}

function isValidSelection(mode: PaletteMode, id: string): boolean {
  return id === ORIGINAL_ID || id === CUSTOM_ID || presetIdsFor(mode).includes(id)
}

function normalizeMode(mode: PaletteMode, raw: unknown): ModePalettePreference {
  if (!isRecord(raw)) return { selected: ORIGINAL_ID }
  const custom = normalizeCustom(raw.custom)
  let selected = typeof raw.selected === 'string' ? raw.selected : ORIGINAL_ID
  if (!isValidSelection(mode, selected) || (selected === CUSTOM_ID && !custom))
    selected = ORIGINAL_ID
  return custom ? { selected, custom } : { selected }
}

export function normalizeAppearancePalettes(raw: unknown): AppearancePalettes {
  if (!isRecord(raw) || raw.schemaVersion !== 1) return clone(DEFAULT_APPEARANCE)
  return {
    schemaVersion: 1,
    light: normalizeMode('light', raw.light),
    dark: normalizeMode('dark', raw.dark)
  }
}

function clone(prefs: AppearancePalettes): AppearancePalettes {
  return JSON.parse(JSON.stringify(prefs)) as AppearancePalettes
}

/** The control values a selection stands for: the Original point, a preset's values, or Custom's. */
export function paramsOf(mode: PaletteMode, pref: ModePalettePreference): CustomPaletteParams {
  if (pref.selected === CUSTOM_ID && pref.custom) return { ...pref.custom }
  const preset = findPreset(mode, pref.selected)
  return { ...(preset ? preset.params : ORIGINAL_POINTS[mode]) }
}

function withMode(
  prefs: AppearancePalettes,
  mode: PaletteMode,
  pref: ModePalettePreference
): AppearancePalettes {
  const next = clone(prefs)
  next[mode] = pref
  return next
}

/**
 * Select Original, a preset or Custom for one mode. Custom values are always
 * kept; selecting Custom for a mode never customized starts it from the
 * currently selected palette, so nothing visibly changes.
 */
export function selectPalette(
  prefs: AppearancePalettes,
  mode: PaletteMode,
  selected: string
): AppearancePalettes {
  if (!isValidSelection(mode, selected)) return prefs
  const current = prefs[mode]
  const custom = current.custom ?? (selected === CUSTOM_ID ? paramsOf(mode, current) : undefined)
  return withMode(prefs, mode, custom ? { selected, custom: { ...custom } } : { selected })
}

/** Store new Custom values for one mode and select Custom. */
export function setCustomParams(
  prefs: AppearancePalettes,
  mode: PaletteMode,
  params: CustomPaletteParams
): AppearancePalettes {
  return withMode(prefs, mode, { selected: CUSTOM_ID, custom: clampCustomParams(params) })
}

/** Copy a preset's (or the Original's) values into Custom and select Custom. */
export function customizeFrom(
  prefs: AppearancePalettes,
  mode: PaletteMode,
  presetId: string
): AppearancePalettes {
  return setCustomParams(prefs, mode, paramsOf(mode, { selected: presetId }))
}

export function sameAppearance(a: AppearancePalettes, b: AppearancePalettes): boolean {
  return (
    JSON.stringify(normalizeAppearancePalettes(a)) ===
    JSON.stringify(normalizeAppearancePalettes(b))
  )
}
