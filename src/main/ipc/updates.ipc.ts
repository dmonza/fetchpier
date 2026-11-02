import { app, ipcMain } from 'electron'
import type { UpdateCheckResponse } from '../../shared/types'
import { checkForUpdates } from '../updates/check'

export function registerUpdatesHandlers(): void {
  ipcMain.handle('updates:check', async (): Promise<UpdateCheckResponse> => {
    return checkForUpdates(app.getVersion())
  })
}
