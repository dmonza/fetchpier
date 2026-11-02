/**
 * The menu's visible vocabulary.
 *
 * The renderer owns the translations and pushes this object on every language
 * resolution (see `pushMenuLabels` in `src/renderer/i18n/index.ts`), exactly as
 * it does for the unresponsive-close dialog. The constants below are a
 * **bootstrap default only**: they label the menu during the interval between
 * the window existing and the interface being ready — an interval in which the
 * menu is entirely disabled (REQ §6.3), so they are never actionable.
 *
 * Not a maintained translation — do not add languages here.
 */
import type { MenuLabels } from '../../shared/types'

export type { MenuLabels }

export const FALLBACK_MENU_LABELS: MenuLabels = {
  app: {
    about: 'About Fetchpier',
    checkUpdates: 'Check for Updates…',
    services: 'Services',
    hide: 'Hide Fetchpier',
    hideOthers: 'Hide Others',
    unhide: 'Show All',
    quit: 'Quit Fetchpier'
  },
  file: {
    label: 'File',
    newRequest: 'New Request',
    newCollection: 'New Collection',
    openWorkspace: 'Open Workspace…',
    closeWorkspace: 'Close Workspace',
    save: 'Save',
    closeTab: 'Close Tab',
    closeAllTabs: 'Close All Tabs',
    closeWindow: 'Close Window'
  },
  edit: {
    label: 'Edit',
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    selectAll: 'Select All'
  },
  request: {
    label: 'Request',
    send: 'Send',
    focusUrl: 'Focus URL'
  },
  view: {
    label: 'View',
    commandPalette: 'Command Palette…',
    toggleSidebar: 'Toggle Sidebar',
    toggleActivityPanel: 'Toggle Activity Panel',
    toggleDevTools: 'Toggle Developer Tools',
    zoomIn: 'Zoom In',
    zoomOut: 'Zoom Out',
    resetZoom: 'Actual Size'
  },
  window: {
    label: 'Window',
    minimize: 'Minimize',
    zoom: 'Zoom',
    front: 'Bring All to Front'
  }
}

/**
 * Structural check against the bootstrap shape: every group the fallback
 * declares must be present, with a string at every leaf. A push that does not
 * match is discarded rather than partially applied — a half-translated menu is
 * worse than an untranslated one.
 */
export function isMenuLabels(value: unknown): value is MenuLabels {
  return matchesShape(value, FALLBACK_MENU_LABELS as unknown as Record<string, unknown>)
}

function matchesShape(value: unknown, shape: Record<string, unknown>): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  for (const key of Object.keys(shape)) {
    const expected = shape[key]
    const actual = candidate[key]
    if (typeof expected === 'string') {
      if (typeof actual !== 'string') return false
    } else if (!matchesShape(actual, expected as Record<string, unknown>)) {
      return false
    }
  }
  return true
}
