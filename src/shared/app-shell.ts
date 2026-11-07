// Constants shared by the startup shell (styled in `main.css`), the window
// factories, and the layout the shell stands in for.
//
// The shell is painted by CSS alone, before any application code runs, so
// nothing here can be derived at runtime — the values are duplicated into
// `src/renderer/assets/main.css` by hand. `app-shell.test.ts` asserts the two
// copies agree, so a change to one that is not mirrored in the other fails a
// test rather than shipping a visible jump at startup.

/**
 * The `BrowserWindow` background, per resolved theme. Must equal the `--canvas`
 * token, which is what `html, body` paint: the window is constructed with this
 * colour before the document exists, so any disagreement shows as a flash.
 */
export const WINDOW_BACKGROUND = {
  light: '#eef0f5',
  dark: '#0b1020'
} as const

/**
 * Prefix of the process argument that carries the resolved theme to a renderer.
 *
 * The window is constructed knowing its theme — it picks `WINDOW_BACKGROUND`
 * from it — so it hands the same value to the renderer process rather than
 * making the renderer ask for it. Asking would mean a synchronous round trip at
 * document start, which stalls the renderer whenever the process it asks is
 * busy; and the platform's own colour-scheme signal does not carry the applied
 * theme on this stack. Read by the preload from its process arguments, ahead of
 * the stylesheet, so the startup shell paints in the right theme.
 */
export const RESOLVED_THEME_ARG = '--fetchpier-resolved-theme='

/**
 * Prefix of the process argument that carries the palette overrides of both
 * modes to a renderer, for the same reason as `RESOLVED_THEME_ARG`: the window
 * is constructed in the palette's canvas colour, and the startup shell has to
 * paint in the same palette before any application code runs. Encoded and
 * validated by `src/shared/palette/launch-arg.ts`.
 */
export const PALETTE_ARG = '--fetchpier-palette='

/**
 * The launch geometry of the application layout. The shell reproduces it so
 * nothing already on screen moves when the interface mounts.
 *
 * - `titleBarHeight` — the `--titlebar-height` token (`TitleBar`).
 * - `tabStripHeight` — `TabBar`'s fixed row height.
 * - `statusBarHeight` — `StatusBar`'s fixed row height.
 * - `sidebarWidth` — the sidebar panel's `defaultSize`. Panel sizes are not
 *   persisted, so this is always the width at launch.
 */
export const SHELL_GEOMETRY = {
  titleBarHeight: '32px',
  tabStripHeight: '36px',
  statusBarHeight: '24px',
  sidebarWidth: '20%'
} as const
