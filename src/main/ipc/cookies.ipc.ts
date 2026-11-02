import { BrowserWindow, ipcMain } from 'electron'
import type { Cookie } from '../../shared/types'
import { requireActiveWorkspaceHandle } from '../state/active-workspace'
import { setActiveEnvironmentForCookies } from './request.ipc'

function broadcast(envId: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('cookies:changed', envId)
  }
}

export function registerCookieHandlers(): void {
  ipcMain.handle(
    'cookies:setActiveEnvironment',
    async (_e, envId: string | null): Promise<void> => {
      setActiveEnvironmentForCookies(envId)
    }
  )

  ipcMain.handle('cookies:list', async (_e, envId: string): Promise<Cookie[]> => {
    if (!envId) return []
    return requireActiveWorkspaceHandle().cookies.list(envId)
  })

  ipcMain.handle(
    'cookies:create',
    async (
      _e,
      envId: string,
      cookie: Omit<Cookie, 'id' | 'createdAt' | 'updatedAt'>
    ): Promise<Cookie> => {
      const created = await requireActiveWorkspaceHandle().cookies.upsert(envId, cookie)
      broadcast(envId)
      return created
    }
  )

  ipcMain.handle(
    'cookies:update',
    async (_e, envId: string, cookieId: string, changes: Partial<Cookie>): Promise<Cookie> => {
      const updated = await requireActiveWorkspaceHandle().cookies.update(envId, cookieId, changes)
      broadcast(envId)
      return updated
    }
  )

  ipcMain.handle('cookies:delete', async (_e, envId: string, cookieId: string): Promise<void> => {
    await requireActiveWorkspaceHandle().cookies.remove(envId, cookieId)
    broadcast(envId)
  })

  ipcMain.handle('cookies:clear', async (_e, envId: string): Promise<void> => {
    await requireActiveWorkspaceHandle().cookies.clear(envId)
    broadcast(envId)
  })

  ipcMain.handle('cookies:deleteJar', async (_e, envId: string): Promise<void> => {
    await requireActiveWorkspaceHandle().cookies.deleteJar(envId)
    broadcast(envId)
  })
}
