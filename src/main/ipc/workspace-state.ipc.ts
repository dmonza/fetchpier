import { ipcMain } from 'electron'
import type { WorkspaceSessionTab, WorkspaceStateView } from '../../shared/types'
import { getView, setActiveEnvironment, setSession } from '../state/workspace-state-store'

/**
 * IPC for the workspace-level personal state
 * (`<workspace>/.fetchpier/.state/workspace-state.json`): the open-tab session
 * plus the active-environment selection. The renderer reads the reconciled view
 * once on workspace open and writes back debounced on every change. Tab paths
 * crossing this boundary are absolute; the store converts to/from the
 * workspace-relative on-disk form and applies path-safety.
 */
export function registerWorkspaceStateHandlers(): void {
  ipcMain.handle('workspace-state:read', async (): Promise<WorkspaceStateView> => {
    return getView()
  })

  ipcMain.handle(
    'workspace-state:setSession',
    async (_e, session: { tabs: WorkspaceSessionTab[]; activeTabIndex: number }): Promise<void> => {
      if (!session || typeof session !== 'object') return
      const tabs = Array.isArray(session.tabs) ? session.tabs : []
      const activeTabIndex =
        typeof session.activeTabIndex === 'number' ? session.activeTabIndex : -1
      setSession(tabs, activeTabIndex)
    }
  )

  ipcMain.handle(
    'workspace-state:setActiveEnvironment',
    async (_e, id: string | null): Promise<void> => {
      setActiveEnvironment(typeof id === 'string' ? id : null)
    }
  )
}
