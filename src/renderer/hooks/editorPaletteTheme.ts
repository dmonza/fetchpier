/**
 * The code editor under a palette other than Original (requirement *Dynamic
 * color themes* §6.9).
 *
 * - **Chrome** — gutter, active line, selection, matches, cursor, search and
 *   autocomplete panels — reads the palette tokens (CSS variables), so it
 *   follows any palette, live drafts included, without reconfiguring.
 * - **Syntax** keeps the active family's hues; a token colour that would fall
 *   below 4.5:1 against the editor's surfaces gets only its lightness moved.
 *   Nothing is recoloured with the accent.
 *
 * Only used when a palette is in force: with Original the editor keeps exactly
 * its current chrome and syntax colours. Families other than `github` and
 * `default` (not selectable in the interface) keep their syntax unadjusted.
 */
import { EditorView } from '@codemirror/view'
import { HighlightStyle, defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { githubDarkStyle, githubLightStyle } from '@uiw/codemirror-theme-github'
import type { Extension } from '@codemirror/state'
import { ensureContrast } from '../../shared/palette/color'
import type { PaletteTokens } from '../../shared/types'

export const PALETTE_CHROME_SPEC = {
  '.cm-content': { caretColor: 'var(--foreground)', color: 'var(--foreground)' },
  '.cm-gutters': {
    backgroundColor: 'var(--muted)',
    color: 'var(--muted-foreground)',
    borderRight: '1px solid var(--border)'
  },
  '.cm-activeLine': { backgroundColor: 'var(--muted)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--accent)', color: 'var(--accent-foreground)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--primary-tint) !important'
  },
  '.cm-selectionMatch, .cm-searchMatch': { backgroundColor: 'var(--accent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--foreground)' },
  '.cm-panels': { backgroundColor: 'var(--popover)', color: 'var(--popover-foreground)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--popover)',
    color: 'var(--popover-foreground)',
    border: '1px solid var(--border)'
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--accent)',
    color: 'var(--accent-foreground)'
  }
} as const

export const paletteChrome: Extension = EditorView.theme(PALETTE_CHROME_SPEC)

type Spec = Record<string, unknown> & { color?: unknown }

function familySpecs(family: string, mode: 'light' | 'dark'): readonly Spec[] | null {
  if (family === 'github')
    return (mode === 'dark' ? githubDarkStyle : githubLightStyle) as readonly Spec[]
  if (family === 'default') return defaultHighlightStyle.specs as readonly Spec[]
  return null
}

const HEX = /^#[0-9a-f]{6}$/i

/** The family's highlight specs with each colour made legible on the palette's editor surfaces. */
export function paletteHighlightSpecs(
  family: string,
  mode: 'light' | 'dark',
  palette: PaletteTokens
): Spec[] | null {
  const specs = familySpecs(family, mode)
  if (!specs) return null
  const against = [palette.background, palette['surface-1']]
  const dir = mode === 'light' ? -1 : 1
  return specs.map((spec) =>
    typeof spec.color === 'string' && HEX.test(spec.color)
      ? { ...spec, color: ensureContrast(spec.color.toLowerCase(), against, 4.5, dir) }
      : { ...spec }
  )
}

const cache = new Map<string, Extension>()

/** Chrome + adjusted syntax for `palette`, ahead of the family so it takes precedence. */
export function paletteEditorExtension(
  family: string,
  mode: 'light' | 'dark',
  palette: PaletteTokens
): Extension {
  const key = `${family}|${mode}|${palette.background}|${palette['surface-1']}`
  let syntax = cache.get(key)
  if (!syntax) {
    const specs = paletteHighlightSpecs(family, mode, palette)
    syntax = specs ? syntaxHighlighting(HighlightStyle.define(specs as never)) : []
    if (cache.size > 32) cache.clear()
    cache.set(key, syntax)
  }
  return [paletteChrome, syntax]
}
