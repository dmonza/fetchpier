/**
 * The one place a palette is applied to the document.
 *
 * Overrides are inline custom properties on `<html>`: an inline declaration
 * beats both palette blocks of the stylesheet (`:root` and `.dark`), so it
 * works for either mode and needs no stylesheet of its own. Applying a palette
 * sets its tokens and removes every other palette token, so nothing of a
 * previous palette survives; `null` (Original) removes them all and the
 * stylesheet shows. Properties that are not palette tokens are never touched.
 */
import { PALETTE_TOKENS } from '../../shared/palette/original'
import type { PaletteTokens } from '../../shared/types'

export function applyPaletteOverrides(
  tokens: PaletteTokens | null,
  root: HTMLElement = document.documentElement
): void {
  for (const name of PALETTE_TOKENS) {
    const value = tokens?.[name]
    if (value) root.style.setProperty(`--${name}`, value)
    else root.style.removeProperty(`--${name}`)
  }
}

/** The palette overrides currently inline on `root`. */
export function inlinePaletteOverrides(
  root: HTMLElement = document.documentElement
): PaletteTokens {
  const out: PaletteTokens = {}
  for (const name of PALETTE_TOKENS) {
    const value = root.style.getPropertyValue(`--${name}`)
    if (value) out[name] = value
  }
  return out
}

type Frame = (callback: () => void) => number

const defaultFrame: Frame = (cb) =>
  typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(cb)
    : (setTimeout(cb, 16) as unknown as number)

export interface FrameApplier {
  /** Apply at the next frame; several calls in one frame apply once, with the latest palette. */
  (tokens: PaletteTokens | null): void
  /** Apply now and drop anything pending (a mode switch must land in the same frame as its class). */
  now: (tokens: PaletteTokens | null) => void
}

export function createFrameApplier(
  apply: (tokens: PaletteTokens | null) => void = applyPaletteOverrides,
  frame: Frame = defaultFrame
): FrameApplier {
  let pending: { tokens: PaletteTokens | null } | null = null
  let scheduled = false
  const schedule = ((tokens: PaletteTokens | null) => {
    pending = { tokens }
    if (scheduled) return
    scheduled = true
    frame(() => {
      scheduled = false
      const next = pending
      pending = null
      if (next) apply(next.tokens)
    })
  }) as FrameApplier
  schedule.now = (tokens) => {
    pending = null
    apply(tokens)
  }
  return schedule
}
