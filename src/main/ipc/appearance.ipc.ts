/**
 * The appearance domain: the user's palette per mode and the open workspace's
 * override of it (requirements *Dynamic color themes* §5.5, *Workspace color
 * palettes* §5.5).
 *
 * - `appearance:get` — the user's preferences, the open workspace's (or `null`),
 *   and the **effective** palettes. Never writes: normalization is display-level.
 * - `appearance:set` — the user level: validates (a non-object is rejected,
 *   anything else normalized), persists through the throwing settings writer.
 * - `appearance:setWorkspace` — the workspace level: same validation, requires
 *   an open workspace, persists at once into its personal state (throws on
 *   failure).
 * - After every write — and whenever a workspace is opened, switched or closed
 *   (`broadcastAppearance`) — every window is told and its background follows.
 */
import { BrowserWindow, ipcMain } from 'electron'
import { readAppSettings, writeAppSettingsStrict } from './appsettings.ipc'
import {
  getWorkspaceAppearanceRaw,
  hasActiveWorkspace,
  setWorkspaceAppearance
} from '../state/workspace-state-store'
import {
  appearanceFrom,
  getStartupWorkspaceHint,
  updateWindowBackgrounds
} from '../window/window-appearance'
import {
  normalizeAppearancePalettes,
  normalizeWorkspacePalettes
} from '../../shared/palette/preferences'
import type { AppearanceState } from '../../shared/types'

export const APPEARANCE_CHANGED = 'appearance:changed'

/** The open workspace's raw block; while the startup restore is pending, the hinted one; `null` with no workspace. */
function workspaceRaw(): unknown | null {
  if (hasActiveWorkspace()) return getWorkspaceAppearanceRaw()
  const hint = getStartupWorkspaceHint()
  return hint ? hint.raw : null
}

export function currentAppearance(): AppearanceState {
  return appearanceFrom(readAppSettings(), workspaceRaw())
}

/** Tell every window the appearance in force and move their backgrounds onto it. */
export function broadcastAppearance(state: AppearanceState = currentAppearance()): AppearanceState {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(APPEARANCE_CHANGED, state)
  }
  updateWindowBackgrounds(state.palettes)
  return state
}

function requireObject(payload: unknown): void {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('Invalid appearance preferences')
  }
}

export function registerAppearanceHandlers(): void {
  ipcMain.handle('appearance:get', (): AppearanceState => currentAppearance())

  ipcMain.handle('appearance:set', (_event, payload: unknown): AppearanceState => {
    requireObject(payload)
    const prefs = normalizeAppearancePalettes(payload)
    writeAppSettingsStrict({ appearancePalettes: prefs })
    return broadcastAppearance()
  })

  ipcMain.handle(
    'appearance:setWorkspace',
    async (_event, payload: unknown): Promise<AppearanceState> => {
      requireObject(payload)
      if (!hasActiveWorkspace()) throw new Error('No workspace is open')
      await setWorkspaceAppearance(normalizeWorkspacePalettes(payload))
      return broadcastAppearance()
    }
  )
}
