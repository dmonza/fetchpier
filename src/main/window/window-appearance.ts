/**
 * What a window needs to know about the palette before and after it exists.
 *
 * On the startup path: the window factory reads the settings it already reads
 * for the bounds, and this turns them into the colour the window is
 * constructed with and the launch arguments its preload applies at document
 * start. Pure apart from `nativeTheme` / `BrowserWindow` in the upkeep helper,
 * and free of anything heavy, because everything reachable from here postpones
 * the first window (SYSTEM §3.10).
 */
import { BrowserWindow, nativeTheme } from 'electron'
import { readAppSettings } from '../ipc/appsettings.ipc'
import { RESOLVED_THEME_ARG, WINDOW_BACKGROUND } from '../../shared/app-shell'
import { encodePaletteArg } from '../../shared/palette/launch-arg'
import { normalizeAppearancePalettes } from '../../shared/palette/preferences'
import { resolveModePalettes } from '../../shared/palette/resolve'
import type { AppSettings, AppearanceState, ModePalettes, PaletteMode } from '../../shared/types'

/** The normalized preferences in `settings` and the palettes they stand for. */
export function appearanceFromSettings(settings: Partial<AppSettings>): AppearanceState {
  const prefs = normalizeAppearancePalettes(settings.appearancePalettes)
  return { prefs, palettes: resolveModePalettes(prefs) }
}

/** The colour `html, body` paint in `mode`: the palette's canvas, or the built-in one. */
export function canvasFor(palettes: ModePalettes, mode: PaletteMode): string {
  return palettes[mode]?.canvas ?? WINDOW_BACKGROUND[mode]
}

/** Background colour and launch arguments for a window opening in `resolved`. */
export function windowAppearance(
  settings: Partial<AppSettings>,
  resolved: PaletteMode
): { backgroundColor: string; additionalArguments: string[] } {
  const { palettes } = appearanceFromSettings(settings)
  return {
    backgroundColor: canvasFor(palettes, resolved),
    additionalArguments: [`${RESOLVED_THEME_ARG}${resolved}`, encodePaletteArg(palettes)]
  }
}

/**
 * Keep every open window's background on the canvas in force. The background
 * shows wherever the document has not painted yet (resizes, the next reload),
 * so it has to follow a palette change and a mode change, not just launch.
 */
export function updateWindowBackgrounds(palettes?: ModePalettes): void {
  const current = palettes ?? appearanceFromSettings(readAppSettings()).palettes
  const color = canvasFor(current, nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.setBackgroundColor(color)
  }
}
