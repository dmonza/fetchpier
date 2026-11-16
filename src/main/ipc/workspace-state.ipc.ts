import { ipcMain } from 'electron'
import type { WorkspaceSessionTab, WorkspaceStateView } from '../../shared/types'
import { getView, setActiveEnvironment, setSession } from '../state/workspace-state-store'
import { isMainWindowSender } from './window.ipc'

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
    async (e, session: { tabs: WorkspaceSessionTab[]; activeTabIndex: number }): Promise<void> => {
      // ISS-0164: only the main window owns the open-tab session. The Activity
      // popout shares the preload; a write from it would replace the main
      // window's session with its own snapshot. Ignored, logged without payload.
      if (!isMainWindowSender(e.sender)) {
        console.warn(
          '[workspace-state] Ignored "workspace-state:setSession" from a non-main window'
        )
        return
      }
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
