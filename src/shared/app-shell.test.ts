/**
 * Drift net for the startup shell.
 *
 * The shell is pure CSS — it paints before any application code runs, so it
 * cannot read a TypeScript constant. Its geometry and colours are therefore
 * hand-copied into `main.css`, and this test is what keeps the copies honest:
 * a token or a panel default changed on one side and not the other fails here
 * instead of shipping a visible jump or a theme flash at startup.
 */
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { describe, expect, it } from 'vitest'
import { SHELL_GEOMETRY, WINDOW_BACKGROUND } from './app-shell'

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf-8')

// Comments are stripped first: the stylesheet documents a `{{variable}}` syntax
// inside one, and a brace in a comment would otherwise close a block early.
const css = read('../renderer/assets/main.css').replace(/\/\*[\s\S]*?\*\//g, '')
const appLayout = read('../renderer/components/layout/AppLayout.tsx')

/** Every declaration block introduced by `selector`, in source order. */
function blocks(selector: string): string[] {
  const pattern = new RegExp(
    `(?:^|[\\n,])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^{}]*)\\}`,
    'g'
  )
  return [...css.matchAll(pattern)].map((m) => m[1])
}

/** The value of a custom property inside a block. */
function prop(block: string, name: string): string | undefined {
  const match = block.match(new RegExp(`(?:^|[\\s;])${name}\\s*:\\s*([^;]+);`))
  return match?.[1].trim()
}

describe('startup shell — colour tokens', () => {
  const rootBlock = blocks(':root')[0]
  const darkBlock = blocks('.dark')[0]

  it('finds the palette blocks it asserts against', () => {
    expect(rootBlock).toBeDefined()
    expect(darkBlock).toBeDefined()
  })

  it('constructs the window in the colour the document goes on to paint', () => {
    // `html, body` paint `--canvas`; the window is constructed before the
    // document exists, so a mismatch is a visible flash on every launch.
    expect(prop(rootBlock, '--canvas')).toBe(WINDOW_BACKGROUND.light)
    expect(prop(darkBlock, '--canvas')).toBe(WINDOW_BACKGROUND.dark)
  })

  it('paints the shell from the palette rather than a copy of it', () => {
    // A literal colour here would be a second palette to keep in step with the
    // real one. Reading the tokens means the shell simply cannot drift — and it
    // only works because the theme is on `<html>` before this sheet is applied.
    const shell = blocks('#root:empty')[0]

    for (const [shellToken, paletteToken] of [
      ['--shell-background', '--background'],
      ['--shell-sidebar', '--sidebar'],
      ['--shell-statusbar', '--muted'],
      ['--shell-border', '--border']
    ] as const) {
      expect(prop(shell, shellToken), shellToken).toBe(`var(${paletteToken})`)
      // The token it defers to has to exist in both palettes, or the shell
      // renders with an empty background in one of them.
      expect(prop(rootBlock, paletteToken), `light ${paletteToken}`).toBeDefined()
      expect(prop(darkBlock, paletteToken), `dark ${paletteToken}`).toBeDefined()
    }
  })

  it('does not resolve its theme from the platform colour-scheme query', () => {
    // `prefers-color-scheme` does not follow the theme the main process applies
    // on this stack, so keying the shell off it would paint the OS theme over a
    // window constructed in the user's.
    expect(css).not.toMatch(/prefers-color-scheme/)
  })
})

describe('startup shell — geometry', () => {
  it('matches the title-bar height the interface renders', () => {
    expect(prop(blocks(':root')[0], '--titlebar-height')).toBe(SHELL_GEOMETRY.titleBarHeight)
  })

  it('declares the same geometry the constants do', () => {
    const shell = blocks('#root:empty')[0]
    expect(prop(shell, '--shell-titlebar-height')).toBe(SHELL_GEOMETRY.titleBarHeight)
    expect(prop(shell, '--shell-tabstrip-height')).toBe(SHELL_GEOMETRY.tabStripHeight)
    expect(prop(shell, '--shell-statusbar-height')).toBe(SHELL_GEOMETRY.statusBarHeight)
    expect(prop(shell, '--shell-sidebar-width')).toBe(SHELL_GEOMETRY.sidebarWidth)
  })

  it('keeps the layout sourcing its sidebar default from the shared constant', () => {
    // A literal here would silently drift from the shell the next time it changes.
    expect(appLayout).toContain('SHELL_GEOMETRY.sidebarWidth')
    expect(appLayout).not.toMatch(/defaultSize="20%"/)
  })
})
