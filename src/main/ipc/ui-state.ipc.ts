import { BrowserWindow, ipcMain } from 'electron'
import type { RequestUiState, RequestUiStateMap } from '../../shared/types'
import { deleteForRequest, getAll, getForRequest, setForRequest } from '../state/ui-state-store'

function broadcast(requestId: string, state: RequestUiState | null): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('ui-state:changed', { requestId, state })
    }
  }
}

export function registerUiStateHandlers(): void {
  ipcMain.handle(
    'ui-state:read',
    async (_e, requestId: unknown): Promise<RequestUiState | null> => {
      if (typeof requestId !== 'string' || requestId.length === 0) return null
      return getForRequest(requestId)
    }
  )

  ipcMain.handle('ui-state:readAll', async (): Promise<RequestUiStateMap> => {
    return getAll()
  })

  ipcMain.handle(
    'ui-state:write',
    async (_e, requestId: unknown, partial: unknown): Promise<RequestUiState | null> => {
      if (typeof requestId !== 'string' || requestId.length === 0) return null
      const merged = setForRequest(requestId, (partial ?? {}) as RequestUiState)
      const stored = getForRequest(requestId)
      broadcast(requestId, stored)
      return stored ?? merged
    }
  )

  ipcMain.handle('ui-state:delete', async (_e, requestId: unknown): Promise<void> => {
    if (typeof requestId !== 'string' || requestId.length === 0) return
    deleteForRequest(requestId)
    broadcast(requestId, null)
  })
}
