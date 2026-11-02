import { ipcMain, dialog, BrowserWindow, app } from 'electron'
import { promises as fs } from 'fs'
import path, { join } from 'path'
import { workspace } from '@fetchpier/core'
import { startWatcher, stopWatcher } from '../watcher'
import type {
  OpenPathResult,
  RestoreResult,
  WorkspaceHttpSettings,
  WorkspaceOpenStrings
} from '../../shared/types'
import {
  clearHttpSettingsCache,
  loadHttpSettings,
  updateHttpSettings
} from '../config/workspace-settings-store'
import { DEFAULT_WORKSPACE_HTTP_SETTINGS } from '../config/defaults'
import { setActiveWorkspaceForHttp } from './request.ipc'
import {
  getActiveWorkspaceHandle,
  requireActiveWorkspaceHandle,
  setActiveWorkspace
} from '../state/active-workspace'
import {
  clearWorkspace as clearUiStateWorkspace,
  loadFromWorkspace as loadUiStateForWorkspace
} from '../state/ui-state-store'
import {
  clearWorkspace as clearTreeStateWorkspace,
  loadFromWorkspace as loadTreeStateForWorkspace
} from '../state/tree-state-store'
import {
  clearWorkspace as clearWorkspaceStateWorkspace,
  loadFromWorkspace as loadWorkspaceStateForWorkspace
} from '../state/workspace-state-store'
import { MAX_RECENT, readWorkspaceStore, writeWorkspaceStore } from '../state/recent-workspaces'

const FETCHPIER_DIR = '.fetchpier'

/**
 * True when `p` resolves to a filesystem root (e.g. `C:\`, `\\server\share\`,
 * or `/`). Used to block users from accidentally picking a disk root as their
 * workspace — that would pollute the root with `.fetchpier/` and break
 * `resolveInsideWorkspace` for most operations.
 */
function isFilesystemRoot(p: string): boolean {
  const resolved = path.resolve(p)
  return resolved === path.parse(resolved).root
}

async function rejectRootSelection(
  workspacePath: string,
  strings: WorkspaceOpenStrings
): Promise<void> {
  await dialog.showMessageBox({
    type: 'error',
    buttons: [strings.rootRejectOk],
    defaultId: 0,
    title: strings.rootRejectTitle,
    message: strings.rootRejectMessage,
    detail: strings.rootRejectDetail.replace('{{path}}', workspacePath)
  })
}

async function fetchpierDirExists(workspacePath: string): Promise<boolean> {
  return fs
    .access(join(workspacePath, FETCHPIER_DIR))
    .then(() => true)
    .catch(() => false)
}

/**
 * Where the open/create-workspace dialog should start.
 *
 * Electron 43 sends a `defaultPath`-less dialog to the Downloads folder, which is never
 * where workspaces live. We open in the **parent** of the current workspace rather than
 * inside it: this dialog both opens and creates, so starting inside would list
 * `.fetchpier/`, `environments/` and `requests/` and put the user one click from nesting a
 * workspace inside another. The parent lists the current workspace next to its siblings.
 *
 * `store.path` is `''` exactly when no workspace is selected, and it survives restarts, so
 * the folder it names may be gone by now — hence the existence check before trusting it.
 */
async function workspacePickerDefaultPath(): Promise<string> {
  const store = await readWorkspaceStore()
  if (store.path) {
    const parent = path.dirname(store.path)
    const parentExists = await fs
      .access(parent)
      .then(() => true)
      .catch(() => false)
    if (parentExists) return parent
  }
  return app.getPath('documents')
}

async function confirmNewWorkspace(
  workspacePath: string,
  strings: WorkspaceOpenStrings
): Promise<boolean> {
  const folderName = workspacePath.split(/[/\\]/).pop() ?? workspacePath
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: [strings.createConfirm, strings.createCancel],
    defaultId: 0,
    cancelId: 1,
    title: strings.createTitle,
    message: strings.createMessage.replace('{{name}}', folderName),
    detail: strings.createDetail
  })
  return response === 0
}

/**
 * Create/repair the workspace layout. Owned by @fetchpier/core so the desktop and
 * the CLI never drift.
 *
 * `seedDefaultEnvironment` is the one thing this adapter decides, and it is
 * `true` on exactly one path: creating a workspace where there was none
 * (REQ-0121 §6.1). Every other caller *opens* an existing workspace and re-runs
 * this defensively, so seeding there would write an environment back into a
 * workspace whose owner deliberately has none — resurrecting a deleted one on the
 * next launch (§6.2).
 */
async function initializeWorkspace(
  workspacePath: string,
  seedDefaultEnvironment = false
): Promise<{ gitignoreCreated: boolean }> {
  return workspace.createWorkspace(workspacePath, { seedDefaultEnvironment })
}

function broadcastGitignoreGenerated(workspacePath: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('workspace:gitignoreGenerated', { workspacePath })
    }
  }
}

async function saveLastWorkspace(workspacePath: string): Promise<void> {
  const store = await readWorkspaceStore()
  const recent = [workspacePath, ...store.recent.filter((p) => p !== workspacePath)].slice(
    0,
    MAX_RECENT
  )
  await writeWorkspaceStore({ path: workspacePath, recent })
}

/**
 * Drop a path from the recent list (e.g. it no longer points at a valid
 * workspace). Leaves `path` (the last-opened pointer) untouched unless it was
 * the removed entry, in which case it is cleared.
 */
async function removeRecentWorkspace(workspacePath: string): Promise<void> {
  const store = await readWorkspaceStore()
  const recent = store.recent.filter((p) => p !== workspacePath)
  const path = store.path === workspacePath ? '' : store.path
  await writeWorkspaceStore({ path, recent })
}

export function registerWorkspaceHandlers(): void {
  const openOrCreateWorkspace = async (
    _event: unknown,
    strings: WorkspaceOpenStrings
  ): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      title: strings.createTitle,
      defaultPath: await workspacePickerDefaultPath(),
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null

    const workspacePath = result.filePaths[0]

    if (isFilesystemRoot(workspacePath)) {
      await rejectRootSelection(workspacePath, strings)
      return null
    }

    const isNew = !(await fetchpierDirExists(workspacePath))
    if (isNew) {
      const confirmed = await confirmNewWorkspace(workspacePath, strings)
      if (!confirmed) return null
    }

    // `isNew` is the create-vs-open signal: it decided the confirmation prompt
    // above, and it decides the default-environment seed here (REQ-0121 §6.1).
    const { gitignoreCreated } = await initializeWorkspace(workspacePath, isNew)
    await saveLastWorkspace(workspacePath)
    await startWatcher(workspacePath)
    setActiveWorkspace(workspacePath)
    setActiveWorkspaceForHttp(workspacePath)
    await loadUiStateForWorkspace(workspacePath)
    // REQ-0113 §6.5: without this the tree-state store stays bound to the
    // PREVIOUS workspace, so this one's expansion set is persisted into the
    // previous one's `.state/tree-state.json`. `getLast` and `openPath` always
    // made this call; this entry point did not.
    await loadTreeStateForWorkspace(workspacePath)
    await loadWorkspaceStateForWorkspace(workspacePath)
    if (gitignoreCreated) broadcastGitignoreGenerated(workspacePath)
    return workspacePath
  }

  ipcMain.handle('workspace:open', openOrCreateWorkspace)
  ipcMain.handle('workspace:create', openOrCreateWorkspace)

  ipcMain.handle('workspace:getLast', async (): Promise<RestoreResult> => {
    try {
      const store = await readWorkspaceStore()
      const workspacePath = store.path
      if (!workspacePath) return { ok: false, reason: 'none' }

      // REQ-0122: the marker decides, not the folder. Both guards run BEFORE
      // initializeWorkspace and must stay there: the layout creation is
      // idempotent by design, so reaching it with an emptied folder rebuilds the
      // skeleton and manufactures the very evidence that would have contradicted
      // the restore. `openPath` has always applied this test; the restore did
      // not, which is how one folder got two opposite treatments.
      const exists = await fs
        .access(workspacePath)
        .then(() => true)
        .catch(() => false)
      if (!exists) {
        await removeRecentWorkspace(workspacePath)
        return { ok: false, reason: 'not-found' }
      }
      if (isFilesystemRoot(workspacePath) || !(await fetchpierDirExists(workspacePath))) {
        await removeRecentWorkspace(workspacePath)
        return { ok: false, reason: 'not-a-workspace' }
      }

      // REQ-0067 §6.5: defensive seed on every desktop open (including silent
      // restore at startup). createWorkspace is idempotent; only fires the
      // gitignoreGenerated event if .gitignore was actually missing. Past the
      // guards above this is a real workspace, so repairing it is right.
      // No environment seed — this is an open, not a creation (REQ-0121 §6.2).
      const { gitignoreCreated } = await initializeWorkspace(workspacePath)
      await startWatcher(workspacePath)
      setActiveWorkspace(workspacePath)
      setActiveWorkspaceForHttp(workspacePath)
      await loadUiStateForWorkspace(workspacePath)
      await loadTreeStateForWorkspace(workspacePath)
      await loadWorkspaceStateForWorkspace(workspacePath)
      if (gitignoreCreated) broadcastGitignoreGenerated(workspacePath)
      return { ok: true, path: workspacePath }
    } catch {
      await stopWatcher()
      return { ok: false, reason: 'none' }
    }
  })

  ipcMain.handle('workspace:getRecent', async (): Promise<string[]> => {
    const store = await readWorkspaceStore()
    // Filter to only paths that still exist
    const results: string[] = []
    for (const p of store.recent) {
      const exists = await fs
        .access(p)
        .then(() => true)
        .catch(() => false)
      if (exists) results.push(p)
    }
    return results
  })

  ipcMain.handle(
    'workspace:openPath',
    async (_event, workspacePath: string): Promise<OpenPathResult> => {
      // Existence first: a recent entry may have been deleted or moved.
      try {
        await fs.access(workspacePath)
      } catch {
        await removeRecentWorkspace(workspacePath)
        return { ok: false, reason: 'not-found' }
      }

      // Unlike open/create, openPath never offers to create a workspace: a
      // recent must already be an initialized workspace (has `.fetchpier/`).
      // A filesystem root is never a valid workspace. Prune the stale entry.
      if (isFilesystemRoot(workspacePath) || !(await fetchpierDirExists(workspacePath))) {
        await removeRecentWorkspace(workspacePath)
        return { ok: false, reason: 'not-a-workspace' }
      }

      // A recent entry is always an existing workspace (guarded above), so this
      // never seeds an environment (REQ-0121 §6.2).
      const { gitignoreCreated } = await initializeWorkspace(workspacePath)
      await saveLastWorkspace(workspacePath)
      await startWatcher(workspacePath)
      setActiveWorkspace(workspacePath)
      setActiveWorkspaceForHttp(workspacePath)
      await loadUiStateForWorkspace(workspacePath)
      await loadTreeStateForWorkspace(workspacePath)
      await loadWorkspaceStateForWorkspace(workspacePath)
      if (gitignoreCreated) broadcastGitignoreGenerated(workspacePath)
      return { ok: true, path: workspacePath }
    }
  )

  ipcMain.handle('workspace:getHttpSettings', async (): Promise<WorkspaceHttpSettings> => {
    // No active workspace yet (app boot before open): return defaults instead
    // of throwing.
    const handle = getActiveWorkspaceHandle()
    if (!handle) return { ...DEFAULT_WORKSPACE_HTTP_SETTINGS }
    return loadHttpSettings(handle.path)
  })

  ipcMain.handle(
    'workspace:updateHttpSettings',
    async (_event, partial: Partial<WorkspaceHttpSettings>): Promise<WorkspaceHttpSettings> => {
      return updateHttpSettings(requireActiveWorkspaceHandle().path, partial)
    }
  )

  ipcMain.handle('workspace:close', async (): Promise<void> => {
    clearHttpSettingsCache()
    setActiveWorkspace(null)
    setActiveWorkspaceForHttp(null)
    clearUiStateWorkspace()
    clearTreeStateWorkspace()
    clearWorkspaceStateWorkspace()
    await stopWatcher()
  })

  /**
   * Absolute path of the user-tree root (`<workspace>/requests/`). The renderer
   * uses this wherever it means "the top of the user file tree" (create at root,
   * move to root, schema import target). The workspace root itself is reserved
   * for app state and other top-level artifact buckets (`environments/`,
   * future `mocks/`, `flows/`).
   */
  ipcMain.handle('workspace:getRequestsRoot', async (): Promise<string> => {
    return requireActiveWorkspaceHandle().tree.requestsRoot()
  })
}
