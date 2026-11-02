import { ipcMain } from 'electron'
import { getAll, setExpanded } from '../state/tree-state-store'

/**
 * IPC for the collection-tree expansion state (`requests/.state/tree-state.json`).
 * The renderer is the source of truth for the set; these handlers just read the
 * cached array (or `null` on first run) and write the full replacement set.
 */
export function registerTreeStateHandlers(): void {
  ipcMain.handle('tree-state:read', async (): Promise<string[] | null> => {
    return getAll()
  })

  ipcMain.handle('tree-state:write', async (_e, paths: unknown): Promise<void> => {
    if (!Array.isArray(paths)) return
    setExpanded(paths)
  })
}
