/**
 * The theme in force for this window, read from the main process rather than
 * from anything the renderer persists.
 *
 * Main resolves the user's preference before the window is created, and the
 * preload marks the document with the result at document start — early enough
 * for the startup shell, which is pure CSS, to paint in the right theme. This
 * module is how the mounted interface adopts that same decision instead of
 * making a second one and correcting a frame later.
 *
 * Note this deliberately does not consult `prefers-color-scheme`: on this stack
 * that query does not follow the theme main applied, so it would report the
 * operating system's theme and disagree with everything else on screen.
 */
export type ResolvedTheme = 'light' | 'dark'

/** The resolved theme right now. Synchronous — safe before the first render. */
export function resolvePlatformTheme(): ResolvedTheme {
  return window.api?.theme?.initialResolved ?? 'light'
}

/**
 * Put the resolved theme on `<html>`, where the stylesheet's dark variant keys
 * off it. The preload has already done this once; calling it again from the
 * entry point keeps the renderer's own view authoritative from its first render
 * and covers a later change.
 */
export function applyResolvedTheme(resolved: ResolvedTheme): ResolvedTheme {
  document.documentElement.classList.toggle('dark', resolved === 'dark')
  return resolved
}

/** Apply whatever theme is currently in force. */
export function applyPlatformTheme(): ResolvedTheme {
  return applyResolvedTheme(resolvePlatformTheme())
}

/**
 * Subscribe to theme changes; returns the unsubscribe function. Main broadcasts
 * on every `nativeTheme` update, which covers both the user picking a different
 * preference and the OS changing while the preference is `system`.
 */
export function onPlatformThemeChange(callback: (resolved: ResolvedTheme) => void): () => void {
  return window.api.theme.onSystemChanged((isDark) => callback(isDark ? 'dark' : 'light'))
}
