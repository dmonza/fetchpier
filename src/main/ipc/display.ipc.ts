import { ipcMain, screen, BrowserWindow } from 'electron'
import { readAppSettings, writeAppSettings } from './appsettings.ipc'

export function getSavedZoomFactor(): number {
  return readAppSettings().zoomFactor
}

export function applyZoom(mainWindow: BrowserWindow, factor: number): number {
  const clamped = Math.max(0.5, Math.min(2.0, factor))
  const stepped = Math.round(clamped * 10) / 10
  mainWindow.webContents.setZoomFactor(stepped)
  writeAppSettings({ zoomFactor: stepped })
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send('display:zoomChanged', stepped)
  }
  return stepped
}

// Re-registered per window (window re-creation after all windows closed —
// see window.ipc.ts's `registerWindowHandlers` for the matching pattern);
// the globally registered handlers below always act on whichever window is
// current.
let currentWindow: BrowserWindow | null = null
let globalHandlersRegistered = false

export function registerDisplayHandlers(mainWindow: BrowserWindow): void {
  currentWindow = mainWindow

  if (globalHandlersRegistered) return
  globalHandlersRegistered = true

  ipcMain.handle('display:getScaleFactor', () => {
    const display = screen.getPrimaryDisplay()
    return display.scaleFactor
  })

  ipcMain.handle('display:getZoom', () => {
    return currentWindow?.webContents.getZoomFactor() ?? 1
  })

  ipcMain.handle('display:setZoom', (_event, factor: number) => {
    return currentWindow ? applyZoom(currentWindow, factor) : factor
  })

  screen.on('display-metrics-changed', () => {
    const display = screen.getPrimaryDisplay()
    if (currentWindow && !currentWindow.isDestroyed()) {
      currentWindow.webContents.send('display:scaleChanged', display.scaleFactor)
    }
  })
}
