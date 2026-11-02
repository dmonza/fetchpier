import { ipcMain, app } from 'electron'

export function registerLocaleHandlers(): void {
  ipcMain.handle('locale:get', (): string => {
    return app.getLocale()
  })
}
