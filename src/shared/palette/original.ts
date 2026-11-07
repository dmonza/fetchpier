/**
 * The built-in ("Original") palettes, as the generator's reference data.
 *
 * These values are the `:root` (light) and `.dark` blocks of
 * `src/renderer/assets/main.css`, copied by hand: the main process needs them
 * before any document exists (to construct a window in a Custom palette's
 * colour), and a stylesheet cannot be imported there. `original.test.ts` asserts
 * the two copies agree token by token, so a change to one that is not mirrored
 * in the other fails instead of drifting.
 *
 * Selecting Original never applies these as overrides — the stylesheet itself is
 * what is shown. They exist so Custom palettes can be derived from them and so a
 * Custom palette at the Original's own point reproduces them exactly.
 */
import type { CustomPaletteParams, PaletteMode, PaletteTokens } from '../types'

/** Every token a palette defines (CSS custom properties, without the leading `--`). */
export const PALETTE_TOKENS = [
  'canvas',
  'background',
  'surface-1',
  'surface-2',
  'surface-3',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'surface-code',
  'border',
  'border-subtle',
  'border-default',
  'border-strong',
  'input',
  'primary',
  'primary-foreground',
  'primary-hover',
  'primary-active',
  'primary-soft',
  'primary-text',
  'primary-tint',
  'ring',
  'focus-glow',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'text-secondary',
  'text-muted',
  'text-soft',
  'success',
  'warning',
  'danger',
  'info',
  'success-text',
  'warning-text',
  'danger-text',
  'info-text',
  'destructive',
  'destructive-foreground',
  'method-get',
  'method-post',
  'method-put',
  'method-patch',
  'method-delete',
  'method-head',
  'method-options',
  'sidebar',
  'fp-var-resolved',
  'fp-var-missing',
  'fp-var-dynamic',
  'fp-var-dynamic-icon',
  'console-string',
  'console-number',
  'console-boolean',
  'console-function'
] as const

export type PaletteToken = (typeof PALETTE_TOKENS)[number]

const LIGHT: Record<PaletteToken, string> = {
  canvas: '#eef0f5',
  background: '#f4f6fa',
  'surface-1': '#ffffff',
  'surface-2': '#e8ecf3',
  'surface-3': '#dce2ed',
  foreground: '#0f172a',
  card: '#ffffff',
  'card-foreground': '#0f172a',
  popover: '#ffffff',
  'popover-foreground': '#0f172a',
  'surface-code': '#edf0f6',
  border: '#d4dbe8',
  'border-subtle': '#d4dbe8',
  'border-default': '#858fa3',
  'border-strong': '#5f6d84',
  input: '#858fa3',
  primary: '#6265f0',
  'primary-foreground': '#ffffff',
  'primary-hover': '#5458e8',
  'primary-active': '#4547d6',
  'primary-soft': '#a5b4fc',
  'primary-text': '#4f46e5',
  'primary-tint': 'rgba(99, 102, 241, 0.14)',
  ring: '#6366f1',
  'focus-glow': 'rgba(99, 102, 241, 0.4)',
  secondary: '#e8ecf3',
  'secondary-foreground': '#0f172a',
  muted: '#e8ecf3',
  'muted-foreground': '#475569',
  accent: '#dce2ed',
  'accent-foreground': '#0f172a',
  'text-secondary': '#334155',
  'text-muted': '#475569',
  'text-soft': '#586577',
  success: '#10b981',
  warning: '#f59e0b',
  danger: '#ef4444',
  info: '#0ea5e9',
  'success-text': '#037353',
  'warning-text': '#a54a02',
  'danger-text': '#b91c1c',
  'info-text': '#0369a1',
  destructive: '#b91c1c',
  'destructive-foreground': '#ffffff',
  'method-get': '#037353',
  'method-post': '#a54a02',
  'method-put': '#1d4ed8',
  'method-patch': '#6d28d9',
  'method-delete': '#b91c1c',
  'method-head': '#be185d',
  'method-options': '#016d89',
  sidebar: '#ffffff',
  'fp-var-resolved': '#017a55',
  'fp-var-missing': '#d6003f',
  'fp-var-dynamic': '#03748f',
  'fp-var-dynamic-icon': '#03748f',
  'console-string': '#047857',
  'console-number': '#0369a1',
  'console-boolean': '#a54a02',
  'console-function': '#7e22ce'
}

const DARK: Record<PaletteToken, string> = {
  canvas: '#0b1020',
  background: '#0f172a',
  'surface-1': '#131c34',
  'surface-2': '#182142',
  'surface-3': '#2a3661',
  foreground: '#e5e7eb',
  card: '#131c34',
  'card-foreground': '#e5e7eb',
  popover: '#182142',
  'popover-foreground': '#e5e7eb',
  'surface-code': '#0d1426',
  border: '#24304a',
  'border-subtle': '#24304a',
  'border-default': '#59688b',
  'border-strong': '#6779a4',
  input: '#556791',
  primary: '#6265f0',
  'primary-foreground': '#ffffff',
  'primary-hover': '#5458e8',
  'primary-active': '#4547d6',
  'primary-soft': '#a5b4fc',
  'primary-text': '#a5b4fc',
  'primary-tint': 'rgba(99, 102, 241, 0.18)',
  ring: '#6c71fd',
  'focus-glow': 'rgba(99, 102, 241, 0.4)',
  secondary: '#182142',
  'secondary-foreground': '#e5e7eb',
  muted: '#182142',
  'muted-foreground': '#acb3c0',
  accent: '#2a3661',
  'accent-foreground': '#e5e7eb',
  'text-secondary': '#c7cedb',
  'text-muted': '#acb3c0',
  'text-soft': '#9aa2b0',
  success: '#10b981',
  warning: '#f59e0b',
  danger: '#f87171',
  info: '#0ea5e9',
  'success-text': '#34d399',
  'warning-text': '#fbbf24',
  'danger-text': '#fca5a5',
  'info-text': '#38bdf8',
  destructive: '#dc2626',
  'destructive-foreground': '#ffffff',
  'method-get': '#34d399',
  'method-post': '#fbbf24',
  'method-put': '#60a5fa',
  'method-patch': '#c4b5fd',
  'method-delete': '#fca5a5',
  'method-head': '#f9a8d4',
  'method-options': '#67e8f9',
  sidebar: '#131c34',
  'fp-var-resolved': '#10b981',
  'fp-var-missing': '#f94462',
  'fp-var-dynamic': '#22d3ee',
  'fp-var-dynamic-icon': '#22d3ee',
  'console-string': '#10b981',
  'console-number': '#0ea5e9',
  'console-boolean': '#f59e0b',
  'console-function': '#b162ff'
}

export const ORIGINAL_PALETTES: Readonly<Record<PaletteMode, Readonly<PaletteTokens>>> = {
  light: LIGHT,
  dark: DARK
}

/**
 * Where each Original sits on the Custom controls. A Custom palette with exactly
 * these values reproduces the Original token by token. `hue` is the accent's hue
 * in the perceptual space, rounded; Light sits at Brightness 100 because its
 * elevated surface is already pure white.
 */
export const ORIGINAL_POINTS: Readonly<Record<PaletteMode, Readonly<CustomPaletteParams>>> = {
  light: { hue: 277, intensity: 80, surfaceTint: 50, brightness: 100 },
  dark: { hue: 277, intensity: 80, surfaceTint: 50, brightness: 50 }
}
