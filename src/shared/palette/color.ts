/**
 * Colour math for the palette engine — pure, dependency-free, deterministic.
 *
 * Palettes are reasoned about in OKLab / OKLCH, a perceptual space: equal steps
 * of lightness look equal whatever the hue, and rotating a hue at constant
 * lightness keeps perceived brightness — unlike the conventional cylindrical RGB
 * model, where a yellow and a blue of the same nominal lightness differ widely.
 * Everything leaves this module as an ordinary sRGB colour (`#rrggbb`, or
 * `rgba(r, g, b, a)` for translucent tokens); the rendering engine is never asked
 * to interpret perceptual colour syntax.
 *
 * Contrast is measured exactly as the accessibility guidelines define it
 * (relative luminance of linearised sRGB), never inferred from lightness.
 */

/** A colour in OKLCH: lightness 0–1, chroma ≥ 0, hue in degrees 0–360. */
export interface Oklch {
  l: number
  c: number
  h: number
}

type Rgb = [number, number, number]

const HEX = /^#([0-9a-f]{6})$/i
const RGBA = /^rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(0|1|0?\.\d+)\s*\)$/

/** Parse `#rrggbb` or `rgba(r, g, b, a)`. `null` for anything else. */
export function parseColor(value: string): { rgb: Rgb; alpha: number } | null {
  const hex = HEX.exec(value.trim())
  if (hex) {
    const n = parseInt(hex[1], 16)
    return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], alpha: 1 }
  }
  const rgba = RGBA.exec(value.trim())
  if (rgba) {
    const rgb = [rgba[1], rgba[2], rgba[3]].map(Number) as Rgb
    if (rgb.some((v) => v > 255)) return null
    return { rgb, alpha: Number(rgba[4]) }
  }
  return null
}

export function formatRgba(rgb: readonly number[], alpha: number): string {
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${Number(alpha.toFixed(3))})`
}

function rgbOf(value: string): Rgb {
  const parsed = parseColor(value)
  if (!parsed) throw new Error(`Not a colour: ${value}`)
  return parsed.rgb
}

function toHexByte(v: number): string {
  return Math.round(Math.min(255, Math.max(0, v)))
    .toString(16)
    .padStart(2, '0')
}

function rgbToHex(rgb: readonly number[]): string {
  return `#${toHexByte(rgb[0])}${toHexByte(rgb[1])}${toHexByte(rgb[2])}`
}

const linearize = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
const delinearize = (v: number): number =>
  v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055

function linearRgb(hex: string): Rgb {
  return rgbOf(hex).map((v) => linearize(v / 255)) as Rgb
}

/** WCAG relative luminance (0 = black, 1 = white). Translucent colours use their opaque RGB. */
export function relativeLuminance(color: string): number {
  const [r, g, b] = linearRgb(rgbToHex(rgbOf(color)))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio between two opaque colours (1–21). */
export function contrastRatio(a: string, b: string): number {
  const x = relativeLuminance(a)
  const y = relativeLuminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

function linearToOklab([r, g, b]: Rgb): Rgb {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ]
}

function oklabToLinear([L, A, B]: Rgb): Rgb {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  ]
}

function oklab(hex: string): Rgb {
  return linearToOklab(linearRgb(hex))
}

export function hexToOklch(hex: string): Oklch {
  const [l, a, b] = oklab(hex)
  const c = Math.hypot(a, b)
  const h = c < 1e-7 ? 0 : (Math.atan2(b, a) * 180) / Math.PI
  return { l, c, h: (h + 360) % 360 }
}

function oklchToLinear({ l, c, h }: Oklch): Rgb {
  const rad = (h * Math.PI) / 180
  return oklabToLinear([l, c * Math.cos(rad), c * Math.sin(rad)])
}

const EPS = 1e-6
const inUnit = (rgb: Rgb): boolean => rgb.every((v) => v >= -EPS && v <= 1 + EPS)

export function isInGamut(color: Oklch): boolean {
  return color.l >= 0 && color.l <= 1 && inUnit(oklchToLinear(color))
}

/**
 * Convert to `#rrggbb`. Out-of-gamut colours keep their lightness and hue and
 * lose chroma (binary search) until they fit — the usual gamut-mapping choice,
 * because lightness is what contrast depends on.
 */
export function oklchToHex(color: Oklch): string {
  const l = Math.min(1, Math.max(0, color.l))
  if (l >= 1 - EPS) return '#ffffff'
  if (l <= EPS) return '#000000'
  let target: Oklch = { l, c: Math.max(0, color.c), h: color.h }
  if (!inUnit(oklchToLinear(target))) {
    let lo = 0
    let hi = target.c
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2
      if (inUnit(oklchToLinear({ l, c: mid, h: color.h }))) lo = mid
      else hi = mid
    }
    target = { l, c: lo, h: color.h }
  }
  const rgb = oklchToLinear(target).map((v) =>
    Math.round(delinearize(Math.min(1, Math.max(0, v))) * 255)
  )
  return rgbToHex(rgb)
}

/** Perceptual distance (Euclidean in OKLab). Translucent colours use their opaque RGB. */
export function deltaE(a: string, b: string): number {
  const p = oklab(rgbToHex(rgbOf(a)))
  const q = oklab(rgbToHex(rgbOf(b)))
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
}

/**
 * Move `hex` in lightness, keeping hue and chroma, until it meets `target`
 * against every colour in `against`. Unchanged when it already does. `dir` is
 * the direction that adds contrast (−1 darker, for light surfaces; +1 lighter).
 * Total: falls back to black or white, whichever contrasts best.
 */
export function ensureContrast(
  hex: string,
  against: string[],
  target: number,
  dir: 1 | -1
): string {
  const passes = (c: string): boolean => against.every((s) => contrastRatio(c, s) >= target)
  if (passes(hex)) return hex
  const o = hexToOklch(hex)
  const at = (shift: number): string => oklchToHex({ l: o.l + dir * shift, c: o.c, h: o.h })
  const room = dir < 0 ? o.l : 1 - o.l
  // Most corrections are small: a few fine steps find them cheapest.
  for (let i = 1; i <= 12 && i * 0.002 <= room; i++) {
    const c = at(i * 0.002)
    if (passes(c)) return c
  }
  if (room > 0.024 && passes(at(room))) {
    // A larger move: moving away from the surfaces only adds contrast, so the
    // smallest shift that passes is found by bisection rather than by stepping.
    let lo = 0.024
    let hi = room
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2
      if (passes(at(mid))) hi = mid
      else lo = mid
    }
    return at(hi)
  }
  const score = (c: string): number => Math.min(...against.map((s) => contrastRatio(c, s)))
  return score('#000000') >= score('#ffffff') ? '#000000' : '#ffffff'
}

/** The opaque colour seen when `color` (possibly translucent) is painted over `background`. */
export function composite(color: string, background: string): string {
  const fg = parseColor(color)
  const bg = rgbOf(background)
  if (!fg) throw new Error(`Not a colour: ${color}`)
  return rgbToHex(fg.rgb.map((c, i) => fg.alpha * c + (1 - fg.alpha) * bg[i]))
}
