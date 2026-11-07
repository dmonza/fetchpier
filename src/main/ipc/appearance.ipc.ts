/**
 * The appearance domain: the user's palette per mode (requirement *Dynamic
 * color themes* §5.5).
 *
 * - `appearance:get` — the normalized preferences and the palettes they stand
 *   for. Never writes: normalization is display-level.
 * - `appearance:set` — validates (a non-object is rejected outright, anything
 *   else is normalized, never stored as received), persists atomically through
 *   the throwing writer so a failure reaches the interface, then tells every
 *   window and moves every window's background onto the canvas in force.
 */
import { BrowserWindow, ipcMain } from 'electron'
import { readAppSettings, writeAppSettingsStrict } from './appsettings.ipc'
import { appearanceFromSettings, updateWindowBackgrounds } from '../window/window-appearance'
import { normalizeAppearancePalettes } from '../../shared/palette/preferences'
import { resolveModePalettes } from '../../shared/palette/resolve'
import type { AppearanceState } from '../../shared/types'

export const APPEARANCE_CHANGED = 'appearance:changed'

export function registerAppearanceHandlers(): void {
  ipcMain.handle('appearance:get', (): AppearanceState => appearanceFromSettings(readAppSettings()))

  ipcMain.handle('appearance:set', (_event, payload: unknown): AppearanceState => {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new Error('Invalid appearance preferences')
    }
    const prefs = normalizeAppearancePalettes(payload)
    writeAppSettingsStrict({ appearancePalettes: prefs })
    const state: AppearanceState = { prefs, palettes: resolveModePalettes(prefs) }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(APPEARANCE_CHANGED, state)
    }
    updateWindowBackgrounds(state.palettes)
    return state
  })
}
