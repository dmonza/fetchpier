import { ipcMain, BrowserWindow } from 'electron'

/**
 * Sender-scoped window controls. Unlike `window.ipc.ts` (whose handlers are
 * bound to the main window via closure), these resolve the BrowserWindow that
 * owns the calling renderer with `BrowserWindow.fromWebContents(event.sender)`.
 *
 * This lets a secondary window — the Activity Panel popout, which is frameless
 * on Windows/Linux — drive its OWN minimize/maximize/close from a custom
 * titlebar without affecting the main window. The popout is a utility window
 * with no editor, so it deliberately skips the main window's unsaved-tabs close
 * guard (`window:close-confirmed`) and closes directly.
 *
 * Every handler is a safe no-op when the sender's window is gone (it may have
 * been destroyed between the renderer's invoke and this handle).
 */
export function registerWindowControlsHandlers(): void {
  ipcMain.handle('window:self-minimize', (event): void => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })

  ipcMain.handle('window:self-maximize-toggle', (event): void => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    if (win.isMaximized()) {
      win.unmaximize()
    } else {
      win.maximize()
    }
  })

  ipcMain.handle('window:self-close', (event): void => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })

  ipcMain.handle('window:self-is-maximized', (event): boolean => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false
  })
}
