/**
 * The palette handed to a new window at launch.
 *
 * Main computes both modes' override maps before it creates a window and passes
 * them in one process argument, base64url-encoded so no shell or command-line
 * parser can alter it. The preload reads it at document start — the same
 * mechanism, and the same reason, as the resolved theme (no round trip while
 * the main process is busy).
 *
 * Decoding is strict: only known palette tokens with plain colour values are
 * accepted, and anything else drops the whole argument (the built-in palette is
 * shown). This is what keeps the argument to validated appearance data and
 * makes it unusable for injecting CSS.
 */
import { PALETTE_ARG } from '../app-shell'
import { parseColor } from './color'
import { PALETTE_TOKENS } from './original'
import type { ModePalettes, PaletteTokens } from '../types'

const MAX_ENCODED_LENGTH = 16_000
const KNOWN = new Set<string>(PALETTE_TOKENS)
const NONE: ModePalettes = { light: null, dark: null }

function toBase64Url(text: string): string {
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(encoded: string): string {
  const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
  return atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
}

export function encodePaletteArg(palettes: ModePalettes): string {
  return PALETTE_ARG + toBase64Url(JSON.stringify({ light: palettes.light, dark: palettes.dark }))
}

function validTokens(value: unknown): PaletteTokens | null | undefined {
  if (value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: PaletteTokens = {}
  for (const [key, color] of Object.entries(value as Record<string, unknown>)) {
    if (!KNOWN.has(key) || typeof color !== 'string' || !parseColor(color)) return undefined
    out[key] = color
  }
  return out
}

export function decodePaletteArg(argv: readonly string[]): ModePalettes {
  const arg = argv.find((a) => a.startsWith(PALETTE_ARG))
  if (!arg) return NONE
  const encoded = arg.slice(PALETTE_ARG.length)
  if (encoded.length > MAX_ENCODED_LENGTH || !/^[A-Za-z0-9_-]*$/.test(encoded)) return NONE
  try {
    const parsed: unknown = JSON.parse(fromBase64Url(encoded))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return NONE
    const { light, dark } = parsed as Record<string, unknown>
    const l = validTokens(light ?? null)
    const d = validTokens(dark ?? null)
    if (l === undefined || d === undefined) return NONE
    return { light: l, dark: d }
  } catch {
    return NONE
  }
}
