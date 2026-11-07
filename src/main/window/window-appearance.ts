/**
 * What a window needs to know about the palette before and after it exists.
 *
 * On the startup path: the window factory reads the settings it already reads
 * for the bounds and — because the interface restores the last workspace only
 * after it has loaded — the personal state of the workspace about to be
 * restored, so the window is constructed in the **effective** palette's canvas
 * and the preload applies it at document start. Plain file reads and pure
 * palette code only: everything reachable from here postpones the first window
 * (SYSTEM §3.10), so the business layer stays out.
 */
import { BrowserWindow, nativeTheme } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join, parse, resolve } from 'node:path'
import { RESOLVED_THEME_ARG, WINDOW_BACKGROUND } from '../../shared/app-shell'
import { encodePaletteArg } from '../../shared/palette/launch-arg'
import {
  effectivePreferences,
  normalizeAppearancePalettes,
  normalizeWorkspacePalettes
} from '../../shared/palette/preferences'
import { resolveModePalettes } from '../../shared/palette/resolve'
import type { AppSettings, AppearanceState, ModePalettes, PaletteMode } from '../../shared/types'

/**
 * The state for `settings` and a workspace's raw palette block. `workspaceRaw`
 * is `null` when no workspace is open; `undefined` (or anything else) is a
 * workspace whose block is absent or whatever the file holds.
 */
export function appearanceFrom(
  settings: Partial<AppSettings>,
  workspaceRaw: unknown | null
): AppearanceState {
  const prefs = normalizeAppearancePalettes(settings.appearancePalettes)
  const workspace = workspaceRaw === null ? null : normalizeWorkspacePalettes(workspaceRaw)
  return { prefs, workspace, palettes: resolveModePalettes(effectivePreferences(prefs, workspace)) }
}

/** The colour `html, body` paint in `mode`: the palette's canvas, or the built-in one. */
export function canvasFor(palettes: ModePalettes, mode: PaletteMode): string {
  return palettes[mode]?.canvas ?? WINDOW_BACKGROUND[mode]
}

/** Background colour and launch arguments for a window opening in `resolved`. */
export function windowAppearance(
  state: AppearanceState,
  resolved: PaletteMode
): { backgroundColor: string; additionalArguments: string[] } {
  return {
    backgroundColor: canvasFor(state.palettes, resolved),
    additionalArguments: [`${RESOLVED_THEME_ARG}${resolved}`, encodePaletteArg(state.palettes)]
  }
}

/**
 * The workspace the interface is about to restore, read before it is restored.
 * Mirrors the restore conditions (a pointer, the folder exists, it is not a
 * filesystem root, it holds `.fetchpier/`); `restorable: false` when any fails
 * or the pointer cannot be read. `raw` is the palette block as the file holds
 * it (`undefined` when absent or unreadable — the workspace then inherits).
 */
export function readStartupWorkspace(userDataDir: string): { restorable: boolean; raw?: unknown } {
  let path: unknown
  try {
    path = (
      JSON.parse(readFileSync(join(userDataDir, 'last-workspace.json'), 'utf-8')) as {
        path?: unknown
      }
    ).path
  } catch {
    return { restorable: false }
  }
  if (typeof path !== 'string' || path.length === 0) return { restorable: false }
  const resolved = resolve(path)
  if (resolved === parse(resolved).root) return { restorable: false }
  if (!existsSync(resolved) || !existsSync(join(resolved, '.fetchpier')))
    return { restorable: false }
  try {
    const state = JSON.parse(
      readFileSync(join(resolved, '.fetchpier', '.state', 'workspace-state.json'), 'utf-8')
    ) as Record<string, unknown> | null
    return {
      restorable: true,
      raw: state && typeof state === 'object' ? state.appearancePalettes : undefined
    }
  } catch {
    return { restorable: true, raw: undefined }
  }
}

/**
 * The palette block of the workspace about to be restored, held from window
 * creation until the restore settles. While it is held and no workspace is
 * open yet, the appearance state answers with it — otherwise the interface's
 * first read would return the user's palette and the window would flash.
 */
let startupHint: { raw: unknown } | null = null

export function setStartupWorkspaceHint(raw: unknown): void {
  startupHint = { raw }
}

export function clearStartupWorkspaceHint(): void {
  startupHint = null
}

export function getStartupWorkspaceHint(): { raw: unknown } | null {
  return startupHint
}

/**
 * Keep every open window's background on the canvas in force. The background
 * shows wherever the document has not painted yet (resizes, the next reload),
 * so it has to follow every palette, workspace and mode change, not just launch.
 */
export function updateWindowBackgrounds(palettes: ModePalettes): void {
  const color = canvasFor(palettes, nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.setBackgroundColor(color)
  }
}
