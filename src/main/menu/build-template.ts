import type { MenuItemConstructorOptions } from 'electron'
import { deriveMenuEnablement, type MenuItemId, type MenuState } from '../../shared/menu-model'
import type { MenuLabels } from './labels'

/**
 * Builds the Electron menu template from a state, a vocabulary and a build
 * flavour. Pure — it touches no window and no Electron singleton, so the shape
 * of the menu is assertable without an app.
 *
 * REQ Application menu coherence on macOS §6.1, §6.8, §6.10.
 */

export type ZoomIntent = 'in' | 'out' | 'reset'

export interface MenuTemplateDeps {
  state: MenuState
  labels: MenuLabels
  /** Developer tools exist only in development builds (REQ §6.10). */
  isDev: boolean
  /** Application name, used for the macOS application menu's own title. */
  appName?: string
  /** An item the interface performs: hand its id over the action channel. */
  onAction: (id: MenuItemId) => void
  onZoom: (intent: ZoomIntent) => void
  onToggleDevTools: () => void
  onCloseFocusedWindow: () => void
}

/**
 * The items the **interface** performs. They display their shortcut but do not
 * register it with the platform (`registerAccelerator: false`), so the single
 * implementation lives in the renderer's keyboard handler and one gate governs
 * both paths. See REQ §6.8 and the design note in `shared/menu-model.ts`.
 */
export const RENDERER_SERVED_ITEMS = [
  'app.about',
  'app.checkUpdates',
  'file.newRequest',
  'file.newCollection',
  'file.openWorkspace',
  'file.closeWorkspace',
  'file.save',
  'file.closeTab',
  'file.closeAllTabs',
  'request.send',
  'request.focusUrl',
  'view.commandPalette',
  'view.toggleSidebar',
  'view.toggleActivityPanel'
] as const satisfies readonly MenuItemId[]

/** Displayed next to the item. Absent means the action has no shortcut. */
const ACCELERATORS: Partial<Record<MenuItemId, string>> = {
  'file.newRequest': 'CmdOrCtrl+N',
  'file.newCollection': 'CmdOrCtrl+Shift+N',
  'file.openWorkspace': 'CmdOrCtrl+O',
  'file.save': 'CmdOrCtrl+S',
  'file.closeTab': 'CmdOrCtrl+W',
  'file.closeWindow': 'CmdOrCtrl+Shift+W',
  'request.send': 'CmdOrCtrl+Return',
  'request.focusUrl': 'CmdOrCtrl+L',
  'view.commandPalette': 'CmdOrCtrl+P',
  'view.toggleSidebar': 'CmdOrCtrl+B',
  'view.toggleActivityPanel': 'CmdOrCtrl+J',
  'view.toggleDevTools': 'Alt+Cmd+I',
  'view.zoomIn': 'CmdOrCtrl+=',
  'view.zoomOut': 'CmdOrCtrl+-',
  'view.resetZoom': 'CmdOrCtrl+0'
}

export function buildMenuTemplate(deps: MenuTemplateDeps): MenuItemConstructorOptions[] {
  const { state, labels, isDev, onAction, onZoom, onToggleDevTools, onCloseFocusedWindow } = deps
  const appName = deps.appName ?? 'Fetchpier'
  const enabled = deriveMenuEnablement(state)

  /** An item the interface performs: shortcut shown, not claimed. */
  const served = (id: MenuItemId, label: string): MenuItemConstructorOptions => {
    const accelerator = ACCELERATORS[id]
    return {
      id,
      label,
      enabled: enabled[id],
      ...(accelerator ? { accelerator, registerAccelerator: false } : {}),
      click: () => onAction(id)
    }
  }

  /** An item this process performs: it must claim a real shortcut to fire. */
  const owned = (id: MenuItemId, label: string, click: () => void): MenuItemConstructorOptions => ({
    id,
    label,
    enabled: enabled[id],
    ...(ACCELERATORS[id] ? { accelerator: ACCELERATORS[id] } : {}),
    click
  })

  const separator: MenuItemConstructorOptions = { type: 'separator' }

  return [
    {
      label: appName,
      submenu: [
        served('app.about', labels.app.about),
        served('app.checkUpdates', labels.app.checkUpdates),
        separator,
        { role: 'services', label: labels.app.services },
        separator,
        { role: 'hide', label: labels.app.hide },
        { role: 'hideOthers', label: labels.app.hideOthers },
        { role: 'unhide', label: labels.app.unhide },
        separator,
        // Never gated: the application must always be quittable, including
        // while the interface is still starting (REQ §6.3).
        { role: 'quit', label: labels.app.quit }
      ]
    },

    {
      label: labels.file.label,
      submenu: [
        served('file.newRequest', labels.file.newRequest),
        served('file.newCollection', labels.file.newCollection),
        separator,
        served('file.openWorkspace', labels.file.openWorkspace),
        served('file.closeWorkspace', labels.file.closeWorkspace),
        separator,
        served('file.save', labels.file.save),
        separator,
        served('file.closeTab', labels.file.closeTab),
        served('file.closeAllTabs', labels.file.closeAllTabs),
        separator,
        // Owned here, not by the interface: with the detached activity window
        // focused this must close *that* window, and the interface's handler
        // only ever runs in the main window (REQ §6.5).
        owned('file.closeWindow', labels.file.closeWindow, onCloseFocusedWindow)
      ]
    },

    {
      label: labels.edit.label,
      submenu: [
        { role: 'undo', label: labels.edit.undo },
        { role: 'redo', label: labels.edit.redo },
        separator,
        { role: 'cut', label: labels.edit.cut },
        { role: 'copy', label: labels.edit.copy },
        { role: 'paste', label: labels.edit.paste },
        { role: 'selectAll', label: labels.edit.selectAll }
      ]
    },

    {
      label: labels.request.label,
      submenu: [
        served('request.send', labels.request.send),
        served('request.focusUrl', labels.request.focusUrl)
      ]
    },

    {
      label: labels.view.label,
      submenu: [
        served('view.commandPalette', labels.view.commandPalette),
        separator,
        served('view.toggleSidebar', labels.view.toggleSidebar),
        served('view.toggleActivityPanel', labels.view.toggleActivityPanel),
        separator,
        owned('view.zoomIn', labels.view.zoomIn, () => onZoom('in')),
        owned('view.zoomOut', labels.view.zoomOut, () => onZoom('out')),
        owned('view.resetZoom', labels.view.resetZoom, () => onZoom('reset')),
        ...(isDev
          ? [separator, owned('view.toggleDevTools', labels.view.toggleDevTools, onToggleDevTools)]
          : [])
      ]
    },

    {
      label: labels.window.label,
      submenu: [
        {
          id: 'window.minimize',
          role: 'minimize',
          label: labels.window.minimize,
          enabled: enabled['window.minimize']
        },
        {
          id: 'window.zoom',
          role: 'zoom',
          label: labels.window.zoom,
          enabled: enabled['window.zoom']
        },
        separator,
        {
          id: 'window.front',
          role: 'front',
          label: labels.window.front,
          enabled: enabled['window.front']
        }
      ]
    }
  ]
}
