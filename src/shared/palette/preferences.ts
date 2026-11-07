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
/** Workspace level only: use the user's palette for that mode. */
export const INHERIT_ID = 'inherit'

export const DEFAULT_APPEARANCE: AppearancePalettes = {
  schemaVersion: 1,
  light: { selected: ORIGINAL_ID },
  dark: { selected: ORIGINAL_ID }
}

/** A workspace that expressed no choice inherits the user's palette in both modes. */
export const DEFAULT_WORKSPACE_APPEARANCE: AppearancePalettes = {
  schemaVersion: 1,
  light: { selected: INHERIT_ID },
  dark: { selected: INHERIT_ID }
}

/** Which level a preference block belongs to: the user's (app-global) or a workspace's. */
export type PaletteLevel = 'user' | 'workspace'

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

function isValidSelection(mode: PaletteMode, id: string, level: PaletteLevel = 'user'): boolean {
  return (
    id === ORIGINAL_ID ||
    id === CUSTOM_ID ||
    (level === 'workspace' && id === INHERIT_ID) ||
    presetIdsFor(mode).includes(id)
  )
}

function normalizeMode(
  mode: PaletteMode,
  raw: unknown,
  level: PaletteLevel
): ModePalettePreference {
  // The fallback is the level's neutral choice: Original for the user, inherit
  // for a workspace — a broken workspace choice must never hide the user's own.
  const fallback = level === 'workspace' ? INHERIT_ID : ORIGINAL_ID
  if (!isRecord(raw)) return { selected: fallback }
  const custom = normalizeCustom(raw.custom)
  let selected = typeof raw.selected === 'string' ? raw.selected : fallback
  if (!isValidSelection(mode, selected, level) || (selected === CUSTOM_ID && !custom))
    selected = fallback
  return custom ? { selected, custom } : { selected }
}

export function normalizeAppearancePalettes(raw: unknown): AppearancePalettes {
  if (!isRecord(raw) || raw.schemaVersion !== 1) return clone(DEFAULT_APPEARANCE)
  return {
    schemaVersion: 1,
    light: normalizeMode('light', raw.light, 'user'),
    dark: normalizeMode('dark', raw.dark, 'user')
  }
}

/** A workspace's block: like the user's, with `inherit` allowed and as the fallback. */
export function normalizeWorkspacePalettes(raw: unknown): AppearancePalettes {
  if (!isRecord(raw) || raw.schemaVersion !== 1) return clone(DEFAULT_WORKSPACE_APPEARANCE)
  return {
    schemaVersion: 1,
    light: normalizeMode('light', raw.light, 'workspace'),
    dark: normalizeMode('dark', raw.dark, 'workspace')
  }
}

/** Per mode, the workspace's choice unless it inherits, else the user's. */
export function effectivePreferences(
  user: AppearancePalettes,
  workspace: AppearancePalettes | null
): AppearancePalettes {
  const u = normalizeAppearancePalettes(user)
  if (!workspace) return u
  const w = normalizeWorkspacePalettes(workspace)
  const pick = (mode: PaletteMode): ModePalettePreference =>
    w[mode].selected === INHERIT_ID ? u[mode] : w[mode]
  return { schemaVersion: 1, light: pick('light'), dark: pick('dark') }
}

function clone(prefs: AppearancePalettes): AppearancePalettes {
  return JSON.parse(JSON.stringify(prefs)) as AppearancePalettes
}

/**
 * The control values a selection stands for: the Original point, a preset's
 * values, or Custom's. For `inherit`, the values of the `inherited` preference
 * (the user's palette for that mode).
 */
export function paramsOf(
  mode: PaletteMode,
  pref: ModePalettePreference,
  inherited?: ModePalettePreference
): CustomPaletteParams {
  if (pref.selected === INHERIT_ID && inherited) return paramsOf(mode, inherited)
  if (pref.selected === CUSTOM_ID && pref.custom) return { ...pref.custom }
  const preset = findPreset(mode, pref.selected)
  return { ...(preset ? preset.params : ORIGINAL_POINTS[mode]) }
}

/** For workspace preferences: the user's preference a mode inherits. */
export interface InheritContext {
  inherited?: ModePalettePreference
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
 * Select Original, a preset or Custom for one mode — or, for workspace
 * preferences (when `ctx.inherited` is given), `inherit`. Custom values are
 * always kept; selecting Custom for a mode never customized starts it from the
 * currently selected palette (the inherited one when the mode inherits), so
 * nothing visibly changes.
 */
export function selectPalette(
  prefs: AppearancePalettes,
  mode: PaletteMode,
  selected: string,
  ctx: InheritContext = {}
): AppearancePalettes {
  const level: PaletteLevel = ctx.inherited ? 'workspace' : 'user'
  if (!isValidSelection(mode, selected, level)) return prefs
  const current = prefs[mode]
  const custom =
    current.custom ?? (selected === CUSTOM_ID ? paramsOf(mode, current, ctx.inherited) : undefined)
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

/**
 * Copy a preset's (or the Original's, or — with `ctx.inherited` — the inherited
 * palette's) values into Custom and select Custom.
 */
export function customizeFrom(
  prefs: AppearancePalettes,
  mode: PaletteMode,
  presetId: string,
  ctx: InheritContext = {}
): AppearancePalettes {
  return setCustomParams(prefs, mode, paramsOf(mode, { selected: presetId }, ctx.inherited))
}

export function sameAppearance(
  a: AppearancePalettes,
  b: AppearancePalettes,
  level: PaletteLevel = 'user'
): boolean {
  const norm = level === 'workspace' ? normalizeWorkspacePalettes : normalizeAppearancePalettes
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b))
}
