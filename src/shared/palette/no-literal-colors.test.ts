/**
 * Guard: interface colours come from the palette tokens, never from fixed
 * colour classes or literals in renderer components. A fixed colour ignores
 * every palette the user picks and is not covered by the contrast targets
 * (requirement *Dynamic color themes* §6.9).
 *
 * The allowlist is the deliberate exceptions: the red hover of the window's
 * close button (a platform convention), the dark backdrops of modal surfaces,
 * and a neutral shadow.
 *
 * Lives with the palette (node environment) because it reads renderer sources
 * off disk, which the renderer's own type configuration rightly forbids.
 */
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, sep } from 'path'
import { fileURLToPath } from 'url'
import { describe, expect, it } from 'vitest'

const RENDERER = fileURLToPath(new URL('../../renderer', import.meta.url))

const PALETTE_CLASS =
  /(?<![\w-])(?:[a-z0-9-]+:)*(?:bg|text|border|ring|fill|stroke|outline|from|via|to|divide|decoration|caret|accent)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black)(?:-\d{2,3})?(?:\/\d{1,3})?(?![\w-])/g
const RAW_COLOR = /#[0-9a-fA-F]{6}\b|rgba?\(/g

const ALLOWED: Record<string, string[]> = {
  'components/layout/WindowControls.tsx': ['hover:bg-red-600', 'hover:text-white'],
  'components/ui/dialog.tsx': ['bg-black/60'],
  'components/layout/CommandPalette.tsx': ['bg-black/50', 'dark:bg-white/10'],
  'components/activity-panel/ActivityPanelHost.tsx': ['rgba(', 'rgba(']
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    if (!/\.(ts|tsx)$/.test(name) || /\.test\.(ts|tsx)$/.test(name) || /\.d\.ts$/.test(name))
      return []
    return [path]
  })
}

describe('no fixed colours in renderer code', () => {
  it('uses palette tokens instead of fixed colour classes or literals', () => {
    const offenders: string[] = []
    for (const file of sources(RENDERER)) {
      const rel = relative(RENDERER, file).split(sep).join('/')
      const text = readFileSync(file, 'utf-8')
      const found = [...(text.match(PALETTE_CLASS) ?? []), ...(text.match(RAW_COLOR) ?? [])]
      const allowed = [...(ALLOWED[rel] ?? [])]
      for (const hit of found) {
        const i = allowed.indexOf(hit)
        if (i >= 0) allowed.splice(i, 1)
        else offenders.push(`${rel}: ${hit}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
