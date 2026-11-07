/**
 * The revised Original palettes (requirement *Dynamic color themes* §6.4.2).
 *
 * Three nets: the generator's copy of the Original equals the stylesheet; the
 * Original meets every contrast target; and, against a frozen copy of the values
 * shipped before the revision, nothing changed outside the revision and the
 * contrast fixes only moved lightness.
 */
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { describe, expect, it } from 'vitest'
import { hexToOklch, parseColor } from './color'
import { ORIGINAL_PALETTES, ORIGINAL_POINTS, PALETTE_TOKENS } from './original'
import { paletteViolations } from './rules'
import type { PaletteMode } from '../types'

const css = readFileSync(
  fileURLToPath(new URL('../../renderer/assets/main.css', import.meta.url)),
  'utf-8'
).replace(/\/\*[\s\S]*?\*\//g, '')

/** All custom properties declared in every top-level block of `selector`, merged in order. */
function declared(selector: string): Record<string, string> {
  const pattern = new RegExp(
    `(?:^|[\\n,])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^{}]*)\\}`,
    'g'
  )
  const out: Record<string, string> = {}
  for (const block of css.matchAll(pattern)) {
    for (const m of block[1].matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
      out[m[1]] = m[2].replace(/\s+/g, ' ').replace(/\(\s/g, '(').replace(/\s\)/g, ')').trim()
    }
  }
  return out
}

const STYLESHEET: Record<PaletteMode, Record<string, string>> = {
  light: declared(':root'),
  dark: declared('.dark')
}

/** The palette values shipped before the revision (frozen — do not update). */
const BEFORE: Record<PaletteMode, Record<string, string>> = {
  light: {
    ...ORIGINAL_PALETTES.light,
    'border-default': '#a3aec2',
    'border-strong': '#7c8aa3',
    input: '#a3aec2',
    primary: '#6366f1',
    'text-soft': '#596678',
    'success-text': '#047857',
    'warning-text': '#b45309',
    'method-get': '#047857',
    'method-post': '#b45309',
    'method-options': '#0e7490',
    'fp-var-resolved': '#059669',
    'fp-var-missing': '#e11d48',
    'fp-var-dynamic': '#0891b2',
    'fp-var-dynamic-icon': '#0891b2',
    'console-boolean': '#b45309'
  },
  dark: {
    ...ORIGINAL_PALETTES.dark,
    'surface-1': '#111827',
    card: '#111827',
    sidebar: '#111827',
    'border-default': '#2d3a5a',
    'border-strong': '#3a4a72',
    input: '#3a4a72',
    primary: '#6366f1',
    ring: '#6366f1',
    'muted-foreground': '#9ca3af',
    'text-muted': '#9ca3af',
    'text-soft': '#94a3af',
    'fp-var-missing': '#f43f5e',
    'console-function': '#a855f7'
  }
}

/** Tokens the revision changed only in lightness (contrast fixes and ramp order). */
const LIGHTNESS_ONLY: Record<PaletteMode, string[]> = {
  light: [
    'border-default',
    'border-strong',
    'input',
    'primary',
    'text-soft',
    'success-text',
    'warning-text',
    'method-get',
    'method-post',
    'method-options',
    'fp-var-resolved',
    'fp-var-missing',
    'fp-var-dynamic',
    'fp-var-dynamic-icon',
    'console-boolean'
  ],
  dark: [
    'border-default',
    'border-strong',
    'input',
    'primary',
    'ring',
    'muted-foreground',
    'text-muted',
    'fp-var-missing',
    'console-function'
  ]
}

/** Tokens the revision restructured (Dark depth step, Dark soft-text hue). */
const STRUCTURAL: Record<PaletteMode, string[]> = {
  light: [],
  dark: ['surface-1', 'card', 'sidebar', 'text-soft']
}

const MODES: PaletteMode[] = ['light', 'dark']

describe.each(MODES)('Original palette — %s', (mode) => {
  const original = ORIGINAL_PALETTES[mode]

  it('defines every palette token and nothing else', () => {
    expect(Object.keys(original).sort()).toEqual([...PALETTE_TOKENS].sort())
  })

  it('equals the stylesheet token by token', () => {
    for (const token of PALETTE_TOKENS) {
      expect({ token, value: STYLESHEET[mode][token] }).toEqual({ token, value: original[token] })
    }
  })

  it('meets every contrast, ramp and selection target', () => {
    expect(paletteViolations(original, mode)).toEqual([])
  })

  it('changed nothing outside the revision', () => {
    const touched = new Set([...LIGHTNESS_ONLY[mode], ...STRUCTURAL[mode]])
    for (const token of PALETTE_TOKENS) {
      if (touched.has(token)) {
        expect({ token, changed: BEFORE[mode][token] !== original[token] }).toEqual({
          token,
          changed: true
        })
      } else {
        expect({ token, value: original[token] }).toEqual({ token, value: BEFORE[mode][token] })
      }
    }
  })

  it('moved the contrast fixes in lightness only, keeping hue and chroma', () => {
    for (const token of LIGHTNESS_ONLY[mode]) {
      const before = hexToOklch(BEFORE[mode][token])
      const after = hexToOklch(original[token])
      expect({ token, chroma: Math.abs(after.c - before.c) <= 0.02 }).toEqual({
        token,
        chroma: true
      })
      expect({ token, hue: Math.abs(after.h - before.h) <= 3 }).toEqual({ token, hue: true })
    }
  })

  it('places the Original point at the accent hue, rounded', () => {
    expect(ORIGINAL_POINTS[mode].hue).toBe(Math.round(hexToOklch(original.primary).h))
  })

  it('only uses colour values the launch path accepts', () => {
    for (const token of PALETTE_TOKENS) expect(parseColor(original[token])).not.toBeNull()
  })
})
