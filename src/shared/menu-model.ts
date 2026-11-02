/**
 * The application menu's enablement rule — the single authority for "can this
 * action be performed right now", shared by the two surfaces that need it.
 *
 * Main derives the native menu from it. The renderer derives its keyboard gate
 * from it, over a state built from its own stores. There are two consumers
 * because there must be exactly *one* rule: on macOS a **disabled** menu item
 * does not consume its key equivalent — the event falls through to the renderer
 * — so a rule that lived only in the menu would be bypassed from the keyboard.
 *
 * This module is on the main process's eager cold-start path. Keep it pure and
 * dependency-free.
 *
 * REQ Application menu coherence on macOS §6.1, §6.4, §6.8.
 */

/**
 * Every item the menu gates. Native roles (quit, hide, services, undo/copy/paste,
 * …) are deliberately absent: the platform governs them and they are never
 * disabled, which is what keeps the application quittable at all times.
 */
export const MENU_ITEM_IDS = [
  'app.about',
  'app.checkUpdates',
  'file.newRequest',
  'file.newCollection',
  'file.openWorkspace',
  'file.closeWorkspace',
  'file.save',
  'file.closeTab',
  'file.closeAllTabs',
  'file.closeWindow',
  'request.send',
  'request.focusUrl',
  'view.commandPalette',
  'view.toggleSidebar',
  'view.toggleActivityPanel',
  'view.zoomIn',
  'view.zoomOut',
  'view.resetZoom',
  'view.toggleDevTools',
  'window.minimize',
  'window.zoom',
  'window.front'
] as const

export type MenuItemId = (typeof MENU_ITEM_IDS)[number]

/** Which window the platform is currently showing the menu for. */
export type FocusedWindowKind = 'main' | 'popout'

/**
 * Everything the enablement rule reads. Each field is reported by whoever learns
 * it; see the controller in `src/main/menu/`.
 */
export interface MenuState {
  /** A main window exists. False after the last window closes on macOS. */
  hasWindow: boolean
  /** The interface has pushed its menu vocabulary, so it can serve actions. */
  rendererReady: boolean
  /** A workspace is open (the main-side session handle is bound). */
  hasWorkspace: boolean
  /** At least one tab is open. */
  hasAnyTab: boolean
  /** One of the open tabs is active. */
  hasActiveTab: boolean
  /** The window the menu currently describes. */
  focusedWindow: FocusedWindowKind
}

/**
 * The state the menu is installed with, before any window exists. Only the
 * window-reviving items are available from here.
 */
export const INITIAL_MENU_STATE: MenuState = {
  hasWindow: false,
  rendererReady: false,
  hasWorkspace: false,
  hasAnyTab: false,
  hasActiveTab: false,
  focusedWindow: 'main'
}

export function deriveMenuEnablement(state: MenuState): Record<MenuItemId, boolean> {
  const { hasWindow, rendererReady, hasWorkspace, hasAnyTab, hasActiveTab, focusedWindow } = state

  // Nothing application-specific is available before the interface is ready —
  // the window is shown early on purpose and the menu bar is on screen for that
  // whole interval (REQ §6.3). Only the platform roles, which this rule does not
  // model, stay usable then.
  const available = hasWindow && rendererReady

  // The main window is present, loaded, and the one the menu describes. Every
  // action the interface performs needs all three.
  const main = available && focusedWindow === 'main'

  // With no window there is nothing to disable *for*, but the application is
  // still running and the user needs a way back in. These two re-create the
  // window; everything else stays off (REQ §6.4).
  const revive = !hasWindow

  return {
    'app.about': available,
    'app.checkUpdates': available,

    'file.newRequest': revive || main,
    'file.newCollection': main && hasWorkspace,
    'file.openWorkspace': revive || main,
    'file.closeWorkspace': main && hasWorkspace,
    'file.save': main && hasActiveTab,
    'file.closeTab': main && hasActiveTab,
    'file.closeAllTabs': main && hasAnyTab,
    'file.closeWindow': available,

    'request.send': main && hasActiveTab,
    'request.focusUrl': main && hasActiveTab,

    'view.commandPalette': main,
    'view.toggleSidebar': main,
    'view.toggleActivityPanel': main,

    // Zoom, developer tools and the Window menu are window properties, not
    // application state: they apply to whichever window is frontmost, including
    // the detached activity window. They are not gated on focus for that reason
    // — only on the application being past its starting state.
    'view.zoomIn': available,
    'view.zoomOut': available,
    'view.resetZoom': available,
    'view.toggleDevTools': available,

    'window.minimize': available,
    'window.zoom': available,
    'window.front': available
  }
}

export function isMenuItemEnabled(state: MenuState, id: MenuItemId): boolean {
  return deriveMenuEnablement(state)[id]
}
