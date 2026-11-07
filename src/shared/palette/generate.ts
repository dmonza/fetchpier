/**
 * The palette generator: a mode and four control values → a complete palette.
 *
 * Built by token role, anchored on the revised Original of the mode
 * (requirement *Dynamic color themes* §6.4.3):
 *
 * 1. Every surface, border and text colour is the Original's, moved in the
 *    perceptual space: Brightness/Darkness shifts lightness (the whole ramp
 *    moves, so depth is kept), Surface tint scales chroma, Hue rotates.
 * 2. The accent family is rebuilt around the chosen hue and intensity, with its
 *    lightness adapted to the hue so warm or light hues stay vivid.
 * 3. Each role is then solved against the contrast targets of `rules.ts`, in
 *    lightness only and only when it misses — which is why the Original point
 *    returns the Original unchanged and every other point stays continuous.
 *
 * Deterministic and total: every input produces a valid palette.
 */
import {
  contrastRatio,
  composite,
  deltaE,
  ensureContrast,
  formatRgba,
  hexToOklch,
  isInGamut,
  oklchToHex,
  parseColor
} from './color'
import type { Oklch } from './color'
import { ORIGINAL_PALETTES, ORIGINAL_POINTS, PALETTE_TOKENS } from './original'
import {
  ALL_SURFACES,
  BODY_TEXT,
  CONTRAST_RULES,
  CONTROL_BORDERS,
  FIELD_TEXT,
  RAMP_MIN_STEP,
  SELECTION_MIN_DELTA_E,
  STATUS_TEXT
} from './rules'
import type { CustomPaletteParams, PaletteMode, PaletteTokens } from '../types'

/** Surfaces and decorative borders: moved with the ramp, never solved. */
const SURFACE_TOKENS = [
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
  'accent',
  'border',
  'border-subtle'
] as const

const TEXT_TOKENS = [
  ...BODY_TEXT,
  'card-foreground',
  'popover-foreground',
  'secondary-foreground',
  'accent-foreground'
] as const

const TEXT_SURFACES = [...ALL_SURFACES, 'secondary', 'accent']

/** Surface tint 100 scales the Original's surface chroma by this much. */
const TINT_MAX_SCALE: Record<PaletteMode, number> = { light: 3, dark: 1.6 }
/** Chroma a surface gains per unit of tint scale above the Original's (lets white tint too). */
const TINT_EXTRA_CHROMA: Record<PaletteMode, number> = { light: 0.005, dark: 0.006 }
/**
 * Lightness shift at Brightness/Darkness 0 and 100, relative to the Original
 * point. Bounded so Light stays light and Dark stays dark, and so the darkest
 * Dark keeps its canvas far enough above black for 8-bit colour to still tell
 * the depth levels apart.
 */
const SHIFT_AT_0: Record<PaletteMode, number> = { light: -0.11, dark: 0.07 }
const SHIFT_AT_100: Record<PaletteMode, number> = { light: 0, dark: -0.06 }
const ACCENT_MAX_CHROMA = 0.3

const clampInt = (v: number, lo: number, hi: number): number =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : lo

/** Integer controls within range; hue 360 is hue 0. */
export function clampParams(p: CustomPaletteParams): CustomPaletteParams {
  return {
    hue: clampInt(p.hue, 0, 360) % 360,
    intensity: clampInt(p.intensity, 0, 100),
    surfaceTint: clampInt(p.surfaceTint, 0, 100),
    brightness: clampInt(p.brightness, 0, 100)
  }
}

const sameParams = (a: CustomPaletteParams, b: CustomPaletteParams): boolean =>
  a.hue === b.hue % 360 &&
  a.intensity === b.intensity &&
  a.surfaceTint === b.surfaceTint &&
  a.brightness === b.brightness

/** Piecewise-linear map with its knee at the Original's own value. */
function knee(
  value: number,
  at: number,
  atZero: number,
  atKnee: number,
  atHundred: number
): number {
  if (value <= at) return at === 0 ? atKnee : atZero + ((atKnee - atZero) * value) / at
  return at === 100 ? atKnee : atKnee + ((atHundred - atKnee) * (value - at)) / (100 - at)
}

/** Which way is "more contrast" for colours drawn on this mode's surfaces. */
const awayFromSurfaces = (mode: PaletteMode): 1 | -1 => (mode === 'light' ? -1 : 1)

function maxChroma(l: number, h: number): number {
  let lo = 0
  let hi = 0.4
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2
    if (isInGamut({ l, c: mid, h })) lo = mid
    else hi = mid
  }
  return lo
}

/** The accent's lightness: the Original's when the chroma fits there, else the nearest that keeps it vivid. */
function accentLightness(l0: number, c: number, h: number): number {
  if (isInGamut({ l: l0, c, h })) return l0
  let best = l0
  let bestChroma = -1
  for (let l = l0 - 0.25; l <= l0 + 0.3 + 1e-9; l += 0.005) {
    if (l <= 0.05 || l >= 0.97) continue
    const reach = Math.min(c, maxChroma(l, h))
    const better =
      reach > bestChroma + 1e-6 ||
      (Math.abs(reach - bestChroma) <= 1e-6 && Math.abs(l - l0) < Math.abs(best - l0))
    if (better) {
      best = l
      bestChroma = reach
    }
  }
  return best
}

/** Strengthen the earlier levels of a ramp (strongest first) until each step is at least `minStep`. */
function spaceRamp(
  tokens: PaletteTokens,
  ramp: string[],
  mode: PaletteMode,
  minSteps: number[]
): void {
  const dir = awayFromSurfaces(mode)
  for (let i = ramp.length - 2; i >= 0; i--) {
    const weaker = hexToOklch(tokens[ramp[i + 1]])
    const current = hexToOklch(tokens[ramp[i]])
    const step = (current.l - weaker.l) * dir
    const wanted = minSteps[i] + 0.003
    if (step < minSteps[i]) {
      tokens[ramp[i]] = oklchToHex({ l: weaker.l + dir * wanted, c: current.c, h: current.h })
    }
  }
}

function rgba(hex: string, alpha: number): string {
  return formatRgba(parseColor(hex)!.rgb, alpha)
}

export function generatePalette(mode: PaletteMode, input: CustomPaletteParams): PaletteTokens {
  const p = clampParams(input)
  const original = ORIGINAL_PALETTES[mode]
  const point = ORIGINAL_POINTS[mode]
  if (sameParams(p, point)) return { ...original }

  const dHue = p.hue - point.hue
  const k = knee(p.surfaceTint, point.surfaceTint, 0, 1, TINT_MAX_SCALE[mode])
  const extraChroma = k > 1 ? (k - 1) * TINT_EXTRA_CHROMA[mode] : 0
  const dL = knee(p.brightness, point.brightness, SHIFT_AT_0[mode], 0, SHIFT_AT_100[mode])
  const away = awayFromSurfaces(mode)
  const surfaceHue = hexToOklch(original.background).h
  const out: PaletteTokens = {}

  const move = (hex: string, shift: number, scale: number, extra: number): string => {
    if (shift === 0 && scale === 1 && extra === 0 && dHue === 0) return hex
    const o = hexToOklch(hex)
    const hue = o.c < 1e-4 ? surfaceHue : o.h
    return oklchToHex({ l: o.l + shift, c: o.c * scale + extra, h: hue + dHue })
  }

  // 1. Surfaces and decorative borders move with the ramp.
  for (const t of SURFACE_TOKENS) out[t] = move(original[t], dL, k, extraChroma)

  // 2. Text: tinted with the surfaces (capped), then solved against every surface.
  for (const t of TEXT_TOKENS) {
    const o = hexToOklch(original[t])
    const scale = Math.min(k, 2)
    const moved =
      scale === 1 && dHue === 0
        ? original[t]
        : oklchToHex({ l: o.l, c: Math.min(o.c * scale, Math.max(o.c, 0.05)), h: o.h + dHue })
    out[t] = ensureContrast(
      moved,
      TEXT_SURFACES.map((s) => out[s]),
      4.5,
      away
    )
  }
  spaceRamp(out, ['foreground', 'text-secondary', 'text-muted', 'text-soft'], mode, [
    RAMP_MIN_STEP,
    RAMP_MIN_STEP,
    RAMP_MIN_STEP
  ])
  if (original['muted-foreground'] === original['text-muted'])
    out['muted-foreground'] = out['text-muted']

  // 3. Control borders: moved, then solved to 3:1, keeping the border ramp in order.
  for (const t of [...CONTROL_BORDERS, 'border-strong']) {
    out[t] = ensureContrast(
      move(original[t], dL, k, extraChroma),
      [out.background, out['surface-1']],
      3,
      away
    )
  }
  const strongGap = Math.abs(
    hexToOklch(original['border-default']).l - hexToOklch(original['border-strong']).l
  )
  spaceRamp(out, ['border-strong', 'border-default', 'border-subtle'], mode, [
    Math.max(RAMP_MIN_STEP, strongGap - 0.003),
    RAMP_MIN_STEP
  ])

  // 4. The accent family.
  const p0 = hexToOklch(original.primary)
  const c0 = p0.c
  const chroma = knee(p.intensity, point.intensity, 0, c0, ACCENT_MAX_CHROMA)
  const ratio = c0 > 0 ? chroma / c0 : 0
  const hue = p0.h + dHue
  const lightness = accentLightness(p0.l, chroma, hue)
  let primary = oklchToHex({ l: lightness, c: chroma, h: hue })

  const darkOnAccent = oklchToHex({ l: 0.2, c: Math.min(0.03, chroma * 0.15), h: hue })
  let foreground: string
  if (contrastRatio('#ffffff', primary) >= 4.5) foreground = '#ffffff'
  else if (contrastRatio(darkOnAccent, primary) >= 4.5) foreground = darkOnAccent
  else {
    foreground =
      contrastRatio('#ffffff', primary) >= contrastRatio(darkOnAccent, primary)
        ? '#ffffff'
        : darkOnAccent
    primary = ensureContrast(primary, [foreground], 4.5, foreground === '#ffffff' ? -1 : 1)
  }
  const whiteText = foreground === '#ffffff'
  const pl = hexToOklch(primary)
  const relative = (token: string, flip: boolean): Oklch => {
    const o = hexToOklch(original[token])
    const shift = o.l - p0.l
    return { l: pl.l + (flip ? -shift : shift), c: o.c * ratio, h: o.h - p0.h + hue }
  }
  out.primary = primary
  out['primary-foreground'] = foreground
  for (const t of ['primary-hover', 'primary-active']) {
    out[t] = ensureContrast(
      oklchToHex(relative(t, !whiteText)),
      [foreground],
      4.5,
      whiteText ? -1 : 1
    )
  }
  out['primary-soft'] = oklchToHex(relative('primary-soft', false))
  out['primary-text'] = ensureContrast(
    oklchToHex(relative('primary-text', false)),
    [out.background, out['surface-1']],
    4.5,
    away
  )
  out.ring = ensureContrast(
    oklchToHex(relative('ring', false)),
    ['canvas', 'background', 'surface-1', 'surface-2', 'surface-3'].map((s) => out[s]),
    3,
    away
  )
  out['focus-glow'] = rgba(out.ring, parseColor(original['focus-glow'])!.alpha)

  // Selection tint: the Original's opacity, adjusted only if it would read as hover.
  const alpha0 = parseColor(original['primary-tint'])!.alpha
  const distinct = (a: number): boolean =>
    deltaE(composite(rgba(primary, a), out.sidebar), out.accent) >= SELECTION_MIN_DELTA_E
  const alphas = [alpha0]
  for (let a = alpha0 + 0.02; a <= 0.6 + 1e-9; a += 0.02) alphas.push(a)
  for (let a = alpha0 - 0.02; a >= 0.06 - 1e-9; a -= 0.02) alphas.push(a)
  const alpha = alphas.find(distinct) ?? alpha0
  out['primary-tint'] = rgba(primary, Number(alpha.toFixed(3)))

  // 5. Semantic colours: the Original's hue and chroma; lightness only when they would miss.
  for (const t of [...STATUS_TEXT, ...FIELD_TEXT]) {
    const rule = CONTRAST_RULES.find((r) => r.token === t)!
    out[t] = ensureContrast(
      original[t],
      rule.against.map((s) => out[s]),
      rule.target,
      away
    )
  }
  out['fp-var-dynamic-icon'] = out['fp-var-dynamic']

  // 6. Fills that carry meaning on their own stay as they are.
  for (const t of [
    'success',
    'warning',
    'danger',
    'info',
    'destructive',
    'destructive-foreground'
  ]) {
    out[t] = original[t]
  }

  const result: PaletteTokens = {}
  for (const t of PALETTE_TOKENS) result[t] = out[t] ?? original[t]
  return result
}
