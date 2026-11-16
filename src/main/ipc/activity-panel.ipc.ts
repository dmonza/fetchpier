import { BrowserWindow, ipcMain, webContents } from 'electron'
import type { ActivityPanelPopoutEvent } from '../../shared/types'
import { parseActivityPanelRowAction } from '../../shared/lib/activity-panel-row-action'
import { resolveInsideActiveWorkspace } from '../fs/safe-path'
import { createActivityPanelWindow } from '../window/create-activity-panel-window'

/**
 * Module-singleton: at most one popout window exists at a time, owned by the
 * `webContents.id` of the main window that triggered it. A second popout from
 * any other main window is rejected; the existing popout stays attached to its
 * original owner.
 */
let popoutWindow: BrowserWindow | null = null
let ownerWebContentsId: number | null = null

function broadcastToOwner(payload: ActivityPanelPopoutEvent): void {
  if (ownerWebContentsId === null) return
  const target = webContents.fromId(ownerWebContentsId)
  if (target && !target.isDestroyed()) {
    target.send('activity-panel:popout-changed', payload)
  }
}

function isAlive(win: BrowserWindow | null): win is BrowserWindow {
  return !!win && !win.isDestroyed()
}

/**
 * Test seam — production code never calls this; tests use it to reset the
 * module state between scenarios.
 */
export function __resetActivityPanelState(): void {
  popoutWindow = null
  ownerWebContentsId = null
}

export function registerActivityPanelHandlers(): void {
  ipcMain.handle('activityPanel:popout', (event): { ok: true } | { ok: false; reason: string } => {
    if (isAlive(popoutWindow)) {
      return { ok: false, reason: 'already-detached' }
    }
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined
    ownerWebContentsId = event.sender.id
    popoutWindow = createActivityPanelWindow(owner)

    const ownerIdSnapshot = ownerWebContentsId
    popoutWindow.on('closed', () => {
      // The 'close' event below has already broadcast to the owner; if the
      // window is destroyed by some other path (e.g. parent close), this
      // guards the singleton state.
      if (popoutWindow && popoutWindow.isDestroyed()) {
        popoutWindow = null
        ownerWebContentsId = null
      }
    })
    // Use 'close' (fires before destruction) so we can still reach the owner.
    popoutWindow.on('close', () => {
      const target = webContents.fromId(ownerIdSnapshot)
      if (target && !target.isDestroyed()) {
        // Only broadcast a "user-closed" event when the dock handler did not
        // already mark the window as docking-back. The dock handler clears
        // popoutWindow before calling close(), so by checking the singleton
        // we can disambiguate.
        if (popoutWindow !== null) {
          target.send('activity-panel:popout-changed', {
            detached: false,
            openAfter: false
          } satisfies ActivityPanelPopoutEvent)
        }
      }
      popoutWindow = null
      ownerWebContentsId = null
    })

    broadcastToOwner({ detached: true })
    return { ok: true }
  })

  ipcMain.handle('activityPanel:dock', (): { ok: true } => {
    const win = popoutWindow
    if (!isAlive(win)) {
      // Nothing to dock — still report success so the popout's UI doesn't get
      // stuck waiting for an error.
      popoutWindow = null
      return { ok: true }
    }
    // Clear the singleton BEFORE close() so the 'close' handler knows the
    // event is a programmatic dock-back, not a user-initiated OS close.
    popoutWindow = null
    const target = ownerWebContentsId !== null ? webContents.fromId(ownerWebContentsId) : null
    if (target && !target.isDestroyed()) {
      target.send('activity-panel:popout-changed', {
        detached: false,
        openAfter: true
      } satisfies ActivityPanelPopoutEvent)
    }
    ownerWebContentsId = null
    win.close()
    return { ok: true }
  })

  ipcMain.handle('activityPanel:focusPopout', (): boolean => {
    if (!isAlive(popoutWindow)) return false
    if (popoutWindow.isMinimized()) popoutWindow.restore()
    popoutWindow.focus()
    return true
  })

  ipcMain.handle('activityPanel:isPoppedOut', (): boolean => isAlive(popoutWindow))

  /**
   * ISS-0164: a History row action taken in the popout (Open, Raw .http,
   * Repeat, Open source file) runs in the main window that owns it — the popout
   * has no tab bar or editor. Accepted only from the popout's own contents,
   * validated, and a source path must resolve inside the active workspace.
   * The owner receives the validated copy and comes to the front. Returns
   * whether it was delivered; refusals are logged without the payload.
   */
  ipcMain.handle('activityPanel:openInOwner', (event, payload: unknown): boolean => {
    const refuse = (why: string): false => {
      console.warn(`[activity-panel] Refused "activityPanel:openInOwner": ${why}`)
      return false
    }
    if (!isAlive(popoutWindow) || event.sender.id !== popoutWindow.webContents.id) {
      return refuse('sender is not the popout')
    }
    const action = parseActivityPanelRowAction(payload)
    if (!action) return refuse('invalid action')
    if (action.kind === 'open-source-file') {
      try {
        resolveInsideActiveWorkspace(action.sourceFile)
      } catch {
        return refuse('source file outside the active workspace')
      }
    }
    const target = ownerWebContentsId !== null ? webContents.fromId(ownerWebContentsId) : null
    if (!target || target.isDestroyed()) return refuse('owner window is gone')
    target.send('activity-panel:row-action', action)
    const ownerWindow = BrowserWindow.fromWebContents(target)
    if (ownerWindow && !ownerWindow.isDestroyed()) {
      if (ownerWindow.isMinimized()) ownerWindow.restore()
      ownerWindow.focus()
    }
    return true
  })
}
