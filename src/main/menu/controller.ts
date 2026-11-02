import { Menu, BrowserWindow, ipcMain, app } from 'electron'
import { is } from '@electron-toolkit/utils'
import type { MenuItemId, MenuState } from '../../shared/menu-model'
import { buildMenuTemplate, type ZoomIntent } from './build-template'
import { FALLBACK_MENU_LABELS, isMenuLabels, type MenuLabels } from './labels'
import {
  getMenuState,
  notifyMenuStateUnchanged,
  patchMenuState,
  setMenuHasWindow,
  subscribeMenuState
} from './state'

/**
 * Turns the menu state into an actual menu — the only Electron-facing half of
 * the subsystem.
 *
 * Two things this module deliberately does **not** do, because the old builder
 * did and both were defects:
 *
 * 1. It never captures a `BrowserWindow` in a click closure. The window is
 *    resolved at click time from a module ref, so a menu selection made after
 *    the window closed (ordinary on macOS, where the app outlives its last
 *    window) cannot address a destroyed object.
 * 2. It never assumes the menu it built is still correct. Every fact that gates
 *    an item is reported into `state.ts`, and a report that changes the state
 *    rebuilds.
 *
 * This module is on the eager cold-start path — keep its imports minimal.
 *
 * REQ Application menu coherence on macOS §6.2, §6.4, §6.5, §6.6, §6.9.
 */

let labels: MenuLabels = FALLBACK_MENU_LABELS
let mainWindow: BrowserWindow | null = null
let createWindow: (() => void) | null = null
let zoomHandler: ((intent: ZoomIntent) => void) | null = null
let devToolsHandler: (() => void) | null = null
let ipcRegistered = false

subscribeMenuState(() => rebuildMenu())

/** macOS is the only platform that draws an application menu (REQ §6.9). */
function menuIsDrawn(): boolean {
  return process.platform === 'darwin'
}

export function rebuildMenu(): void {
  if (!menuIsDrawn()) {
    // Not "leave it as it is" — Electron installs a default menu otherwise, and
    // a menu nobody can see is exactly what this REQ removes.
    Menu.setApplicationMenu(null)
    return
  }

  const template = buildMenuTemplate({
    state: getMenuState(),
    labels,
    isDev: is.dev,
    appName: app.name,
    onAction: sendMenuAction,
    onZoom: (intent) => zoomHandler?.(intent),
    onToggleDevTools: () => devToolsHandler?.(),
    onCloseFocusedWindow: closeFocusedWindow
  })

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

export function setMenuWindow(win: BrowserWindow | null): void {
  mainWindow = win
  setMenuHasWindow(win !== null)
}

/** The window factory used to revive the app from the no-window state. */
export function setMenuWindowFactory(factory: () => void): void {
  createWindow = factory
}

export function setMenuWindowHandlers(handlers: {
  onZoom: (intent: ZoomIntent) => void
  onToggleDevTools: () => void
}): void {
  zoomHandler = handlers.onZoom
  devToolsHandler = handlers.onToggleDevTools
}

/**
 * The vocabulary push doubles as the readiness signal: the interface can only
 * send this once it has resolved its language, which is part of its start-up
 * (REQ §6.3, §6.6).
 */
export function applyMenuLabels(next: unknown): void {
  if (!isMenuLabels(next)) return
  labels = next
  if (getMenuState().rendererReady) {
    // Language change on an already-ready interface: the state is unchanged, so
    // the subscription would not fire — rebuild explicitly.
    notifyMenuStateUnchanged()
    return
  }
  patchMenuState({ rendererReady: true })
}

/**
 * Hand an action to the window that must serve it. With no window open, the two
 * items that remain enabled create one first (REQ §6.4).
 */
export function sendMenuAction(id: MenuItemId): void {
  if ((!mainWindow || mainWindow.isDestroyed()) && createWindow) {
    createWindow()
  }
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  win.webContents.send('menu:action', id)
}

function closeFocusedWindow(): void {
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow
  if (win && !win.isDestroyed()) win.close()
}

export function registerMenuIpc(): void {
  if (ipcRegistered) return
  ipcRegistered = true

  ipcMain.on('menu:setLabels', (_event, payload: unknown) => applyMenuLabels(payload))

  ipcMain.on('menu:setState', (_event, payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) return
    const p = payload as Record<string, unknown>
    const patch: Partial<MenuState> = {}
    if (typeof p.hasAnyTab === 'boolean') patch.hasAnyTab = p.hasAnyTab
    if (typeof p.hasActiveTab === 'boolean') patch.hasActiveTab = p.hasActiveTab
    patchMenuState(patch)
  })
}

export { getMenuState, patchMenuState, setFocusedWindowKind, setMenuWorkspaceOpen } from './state'
