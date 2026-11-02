import { ipcMain, nativeTheme, BrowserWindow } from 'electron'
import { writeAppSettings } from './appsettings.ipc'
import { THEMES } from '../../shared/types'
import type { Theme } from '../../shared/types'

export function registerThemeHandlers(): void {
  // One-shot query: which theme is currently in force? With the preference
  // applied to `themeSource` at startup, this is the *resolved* theme — the OS
  // theme only when the preference is `system`.
  ipcMain.handle('theme:getSystemIsDark', () => {
    return nativeTheme.shouldUseDarkColors
  })

  // The renderer reports the user's *preference*, not the resolved value:
  // persisting `light`/`dark` for someone who chose `system` would pin the
  // theme to whatever the OS happened to be when they chose it. Applying it to
  // `themeSource` drives native decorations and the `prefers-color-scheme` the
  // renderer resolves against; persisting it is what lets the window factory
  // resolve the theme before any window exists on the next launch.
  ipcMain.handle('theme:setNativeTheme', (_, theme: Theme) => {
    if (!THEMES.includes(theme)) return
    nativeTheme.themeSource = theme
    writeAppSettings({ theme })
  })

  // Forward OS-level theme changes to all renderer windows
  nativeTheme.on('updated', () => {
    const isDark = nativeTheme.shouldUseDarkColors
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) {
        win.webContents.send('theme:systemChanged', isDark)
      }
    })
  })
}
