import { useEffect } from 'react'
import type { MenuItemId } from '@shared/menu-model'

/**
 * The single implementation of every shortcut the interface can perform.
 *
 * The native menu displays these shortcuts but does not register them with the
 * platform (`registerAccelerator: false`), precisely so this hook is the only
 * place any of them is implemented. That matters because on macOS a *disabled*
 * menu item does not consume its key equivalent — the event falls through to
 * here — so a gate that lived only in the menu would be bypassed from the
 * keyboard. `isEnabled` is the same derivation the menu is built from.
 *
 * REQ Application menu coherence on macOS §6.8.
 */

export type ZoomIntent = 'in' | 'out' | 'reset'

interface ShortcutHandlers {
  /** The shared enablement rule, over the renderer's own state. */
  isEnabled: (id: MenuItemId) => boolean
  onSendRequest: () => void
  onNewRequest: () => void
  onNewCollection: () => void
  onOpenWorkspace: () => void
  onCloseTab: () => void
  onCloseWindow: () => void
  onSaveRequest: () => void
  onOpenCommandPalette: () => void
  onFocusUrlBar: () => void
  onToggleSidebar: () => void
  onToggleActivityPanel: () => void
  onZoom: (intent: ZoomIntent) => void
  /** Ctrl+Tab — step backward through most-recently-used order. */
  onNextTab: () => void
  /** Ctrl+Shift+Tab — step forward through most-recently-used order. */
  onPrevTab: () => void
  /** Ctrl+PageDown — next tab in tab-bar order. */
  onPageNextTab: () => void
  /** Ctrl+PageUp — previous tab in tab-bar order. */
  onPagePrevTab: () => void
  /** Ctrl released — commit the MRU cycle (move the landed tab to the front). */
  onTabCycleEnd: () => void
}

/**
 * Registers global keyboard shortcuts for the app.
 * All handlers must be stable (memoized) to avoid re-registration on every render.
 */
export function useKeyboardShortcuts(handlers: ShortcutHandlers): void {
  const {
    isEnabled,
    onSendRequest,
    onNewRequest,
    onNewCollection,
    onOpenWorkspace,
    onCloseTab,
    onCloseWindow,
    onSaveRequest,
    onOpenCommandPalette,
    onFocusUrlBar,
    onToggleSidebar,
    onToggleActivityPanel,
    onZoom,
    onNextTab,
    onPrevTab,
    onPageNextTab,
    onPagePrevTab,
    onTabCycleEnd
  } = handlers

  useEffect(() => {
    /** Run `action` only if the menu would have offered it. */
    const gated = (id: MenuItemId, action: () => void): void => {
      if (isEnabled(id)) action()
    }

    const handleKeyDown = (e: KeyboardEvent): void => {
      const ctrl = e.ctrlKey || e.metaKey
      if (!ctrl) return

      const k = e.key

      // Tab switching: MRU cycling (Ctrl+Tab) and visual-order paging (Ctrl+PgUp/Dn).
      // Ungated — navigating between open tabs is meaningful whenever tabs exist,
      // and the handlers already no-op below two tabs.
      if (k === 'Tab') {
        e.preventDefault()
        if (e.shiftKey) onPrevTab()
        else onNextTab()
        return
      }
      if (k === 'PageDown') {
        e.preventDefault()
        onPageNextTab()
        return
      }
      if (k === 'PageUp') {
        e.preventDefault()
        onPagePrevTab()
        return
      }

      // Closing follows the desktop-editor convention (REQ §6.8): the close
      // shortcut closes the active tab while any is open and closes the window
      // once none is; the shifted one always closes the window.
      if (k.toLowerCase() === 'w') {
        e.preventDefault()
        if (e.shiftKey) {
          gated('file.closeWindow', onCloseWindow)
        } else if (isEnabled('file.closeTab')) {
          onCloseTab()
        } else {
          gated('file.closeWindow', onCloseWindow)
        }
        return
      }

      if (k === 'Enter') {
        e.preventDefault()
        gated('request.send', onSendRequest)
        return
      }

      // Zoom lives here (not in the menu) on the platforms that draw no menu;
      // on macOS the menu owns these accelerators and this never fires.
      if (k === '=' || k === '+') {
        e.preventDefault()
        gated('view.zoomIn', () => onZoom('in'))
        return
      }
      if (k === '-' || k === '_') {
        e.preventDefault()
        gated('view.zoomOut', () => onZoom('out'))
        return
      }
      if (k === '0') {
        e.preventDefault()
        gated('view.resetZoom', () => onZoom('reset'))
        return
      }

      switch (k.toLowerCase()) {
        case 'n':
          e.preventDefault()
          if (e.shiftKey) gated('file.newCollection', onNewCollection)
          else gated('file.newRequest', onNewRequest)
          break
        case 'o':
          e.preventDefault()
          gated('file.openWorkspace', onOpenWorkspace)
          break
        case 's':
          e.preventDefault()
          gated('file.save', onSaveRequest)
          break
        case 'p':
          e.preventDefault()
          gated('view.commandPalette', onOpenCommandPalette)
          break
        case 'l':
          e.preventDefault()
          gated('request.focusUrl', onFocusUrlBar)
          break
        case 'b':
          e.preventDefault()
          gated('view.toggleSidebar', onToggleSidebar)
          break
        case 'j':
          e.preventDefault()
          gated('view.toggleActivityPanel', onToggleActivityPanel)
          break
      }
    }

    // Releasing Ctrl/Cmd ends an in-progress MRU cycle and commits the landing tab.
    const handleKeyUp = (e: KeyboardEvent): void => {
      if (e.key === 'Control' || e.key === 'Meta') onTabCycleEnd()
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [
    isEnabled,
    onSendRequest,
    onNewRequest,
    onNewCollection,
    onOpenWorkspace,
    onCloseTab,
    onCloseWindow,
    onSaveRequest,
    onOpenCommandPalette,
    onFocusUrlBar,
    onToggleSidebar,
    onToggleActivityPanel,
    onZoom,
    onNextTab,
    onPrevTab,
    onPageNextTab,
    onPagePrevTab,
    onTabCycleEnd
  ])
}
