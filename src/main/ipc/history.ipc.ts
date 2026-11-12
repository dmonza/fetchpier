import { BrowserWindow, ipcMain } from 'electron'
import type { HistoryEntry, HistoryEntryListItem, HistoryListFilter } from '../../shared/types'
import { requireActiveWorkspaceHandle } from '../state/active-workspace'

/**
 * Tell every window the runs on disk changed, so each HistoryList (the main
 * window's and a popped-out Activity panel's) reloads. Mirrors `cookies:changed`.
 */
function broadcastChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('history:changed')
  }
}

function validateListFilter(filter: unknown): HistoryListFilter | undefined {
  if (filter === undefined || filter === null) return undefined
  const invalid = (): never => {
    throw new Error('Invalid history filter')
  }
  if (typeof filter !== 'object' || Array.isArray(filter)) invalid()
  const { requestId, requestIds, limit } = filter as Record<string, unknown>
  if (requestId !== undefined && typeof requestId !== 'string') invalid()
  if (
    requestIds !== undefined &&
    (!Array.isArray(requestIds) || requestIds.some((id) => typeof id !== 'string'))
  ) {
    invalid()
  }
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0)) {
    invalid()
  }
  return filter as HistoryListFilter
}

export function registerHistoryHandlers(): void {
  /** Save a history entry to disk. */
  ipcMain.handle('history:save', async (_event, entry: HistoryEntry): Promise<void> => {
    await requireActiveWorkspaceHandle().history.save(entry)
    broadcastChanged()
  })

  /**
   * List history entries ordered by date descending (newest first).
   *
   * REQ-0068: returns lightweight `HistoryEntryListItem`s. To get the full
   * entry, the renderer calls `history:get` (raw `.http` text) and rebuilds
   * via `activityLogToHistoryEntry`.
   */
  ipcMain.handle(
    'history:list',
    async (_event, filter?: unknown): Promise<HistoryEntryListItem[]> => {
      return requireActiveWorkspaceHandle().history.list(validateListFilter(filter))
    }
  )

  /**
   * Read a specific history entry by id, as the raw `.http` text.
   *
   * REQ-0068: returns the on-disk text — the renderer reconstructs the
   * in-memory `HistoryEntry` shape via the shared activity-log helper.
   */
  ipcMain.handle('history:get', async (_event, entryId: string): Promise<string> => {
    return requireActiveWorkspaceHandle().history.get(entryId)
  })

  /** Update sourceFile in history entries when a file or folder is renamed/moved. */
  ipcMain.handle(
    'history:updateSourceFile',
    async (_event, oldRelPath: string, newRelPath: string, isFolder: boolean): Promise<void> => {
      await requireActiveWorkspaceHandle().history.updateSourceFile(
        oldRelPath,
        newRelPath,
        isFolder
      )
      broadcastChanged()
    }
  )

  /** Count history entries linked to a path. */
  ipcMain.handle(
    'history:countForPath',
    async (_event, relPath: string, isFolder: boolean): Promise<number> => {
      return requireActiveWorkspaceHandle().history.countForPath(relPath, isFolder)
    }
  )

  /** Delete all history entries linked to a path. */
  ipcMain.handle(
    'history:deleteForPath',
    async (_event, relPath: string, isFolder: boolean): Promise<void> => {
      await requireActiveWorkspaceHandle().history.deleteForPath(relPath, isFolder)
      broadcastChanged()
    }
  )

  /** Delete a single history entry by id. */
  ipcMain.handle('history:delete', async (_event, entryId: string): Promise<void> => {
    await requireActiveWorkspaceHandle().history.remove(entryId)
    broadcastChanged()
  })

  /** Delete all history files for the workspace. */
  ipcMain.handle('history:clear', async (): Promise<void> => {
    await requireActiveWorkspaceHandle().history.clear()
    broadcastChanged()
  })
}
