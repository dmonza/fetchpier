/**
 * The contrast targets every palette must meet — the revised Original and every
 * preset and Custom palette alike (requirement *Dynamic color themes* §6.4.1).
 *
 * Kept as data so the generator solves against exactly what the tests assert.
 */
import { composite, contrastRatio, deltaE, hexToOklch } from './color'
import type { PaletteTokens } from '../types'

/** Every opaque surface a text colour may sit on. */
export const ALL_SURFACES = [
  'canvas',
  'background',
  'surface-1',
  'surface-2',
  'surface-3',
  'card',
  'popover',
  'surface-code'
] as const

const STATUS_SURFACES = ['background', 'surface-1', 'surface-2', 'surface-3'] as const
const FIELD_SURFACES = ['background', 'surface-1', 'surface-2'] as const

export interface ContrastRule {
  /** The colour being checked. */
  token: string
  /** Surfaces (or fills) it is drawn on. */
  against: readonly string[]
  target: number
}

const rule = (
  tokens: readonly string[],
  against: readonly string[],
  target: number
): ContrastRule[] => tokens.map((token) => ({ token, against, target }))

export const BODY_TEXT = [
  'foreground',
  'text-secondary',
  'text-muted',
  'muted-foreground',
  'text-soft'
] as const

export const STATUS_TEXT = [
  'success-text',
  'warning-text',
  'danger-text',
  'info-text',
  'method-get',
  'method-post',
  'method-put',
  'method-patch',
  'method-delete',
  'method-head',
  'method-options'
] as const

export const FIELD_TEXT = [
  'fp-var-resolved',
  'fp-var-missing',
  'fp-var-dynamic',
  'console-string',
  'console-number',
  'console-boolean',
  'console-function'
] as const

export const CONTROL_BORDERS = ['border-default', 'input'] as const

export const CONTRAST_RULES: readonly ContrastRule[] = [
  ...rule(BODY_TEXT, ALL_SURFACES, 4.5),
  { token: 'card-foreground', against: ['card'], target: 4.5 },
  { token: 'popover-foreground', against: ['popover'], target: 4.5 },
  { token: 'secondary-foreground', against: ['secondary'], target: 4.5 },
  { token: 'accent-foreground', against: ['accent'], target: 4.5 },
  { token: 'primary-text', against: ['background', 'surface-1'], target: 4.5 },
  {
    token: 'primary-foreground',
    against: ['primary', 'primary-hover', 'primary-active'],
    target: 4.5
  },
  { token: 'destructive-foreground', against: ['destructive'], target: 4.5 },
  ...rule(STATUS_TEXT, STATUS_SURFACES, 4.5),
  ...rule(FIELD_TEXT, FIELD_SURFACES, 4.5),
  ...rule(CONTROL_BORDERS, ['background', 'surface-1'], 3),
  {
    token: 'ring',
    against: ['canvas', 'background', 'surface-1', 'surface-2', 'surface-3'],
    target: 3
  }
]

/** Minimum perceptual distance between the selected-row and hovered-row colours. */
export const SELECTION_MIN_DELTA_E = 0.02

/** Minimum lightness step between consecutive levels of the text and border ramps. */
export const RAMP_MIN_STEP = 0.02

export interface Violation {
  rule: string
  detail: string
}

/**
 * Every way `tokens` misses a target. Empty when the palette is compliant.
 * `mode` decides which direction is "stronger" for the ramps (darker on light).
 */
export function paletteViolations(tokens: PaletteTokens, mode: 'light' | 'dark'): Violation[] {
  const out: Violation[] = []
  for (const r of CONTRAST_RULES) {
    for (const surface of r.against) {
      const ratio = contrastRatio(tokens[r.token], tokens[surface])
      if (ratio + 1e-9 < r.target) {
        out.push({
          rule: 'contrast',
          detail: `${r.token} on ${surface}: ${ratio.toFixed(2)} < ${r.target}`
        })
      }
    }
  }
  // Ramps, strongest first: each level is a distinct, weaker step than the one
  // before it. Weaker means lighter on a light palette, darker on a dark one.
  const l = (token: string): number => hexToOklch(tokens[token]).l
  const ramps: string[][] = [
    ['foreground', 'text-secondary', 'text-muted', 'text-soft'],
    ['border-strong', 'border-default', 'border-subtle']
  ]
  for (const ramp of ramps) {
    for (let i = 0; i < ramp.length - 1; i++) {
      const step = mode === 'light' ? l(ramp[i + 1]) - l(ramp[i]) : l(ramp[i]) - l(ramp[i + 1])
      if (step + 1e-9 < RAMP_MIN_STEP) {
        out.push({
          rule: 'ramp',
          detail: `${ramp[i]} → ${ramp[i + 1]} step ${step.toFixed(3)} < ${RAMP_MIN_STEP}`
        })
      }
    }
  }
  const selected = composite(tokens['primary-tint'], tokens.sidebar)
  const distance = deltaE(selected, tokens.accent)
  if (distance + 1e-9 < SELECTION_MIN_DELTA_E) {
    out.push({
      rule: 'selection',
      detail: `selection vs hover ΔE ${distance.toFixed(3)} < ${SELECTION_MIN_DELTA_E}`
    })
  }
  return out
}
