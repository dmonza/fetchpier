import { create } from 'zustand'
import { i18next } from '../i18n'
import type { WorkspaceOpenStrings } from '../../shared/types'
import { useUiStateStore } from './uiState'
import { useTreeStateStore } from './treeState'
import { useToastStore } from './toast'
import { useAppearanceStore } from './appearance'
import { hydrateSession, teardownSession } from '../lib/sessionPersistence'

/**
 * Report a workspace that could not be opened and refresh the (now shorter)
 * recent list. Main already pruned the stale entry, so the two facts the user
 * needs — why it failed, and that the entry is gone — arrive together.
 *
 * Shared by the recent-list open and the launch-time restore (REQ-0122): both
 * apply the same test and drop the entry, so both say the same thing.
 */
async function reportFailedOpen(reason: 'not-found' | 'not-a-workspace'): Promise<string[]> {
  const t = i18next.t.bind(i18next)
  const message =
    reason === 'not-found'
      ? t('workspace.openError.notFound')
      : t('workspace.openError.notAWorkspace')
  useToastStore.getState().push(message, { type: 'error' })
  return window.api.workspace.getRecent()
}

/** Build the localized strings shown by native dialogs in the main process. */
function buildDialogStrings(): WorkspaceOpenStrings {
  const t = i18next.t.bind(i18next)
  return {
    rootRejectTitle: t('workspaceDialog.rootReject.title'),
    rootRejectMessage: t('workspaceDialog.rootReject.message'),
    rootRejectDetail: t('workspaceDialog.rootReject.detail'),
    rootRejectOk: t('workspaceDialog.rootReject.ok'),
    createTitle: t('workspaceDialog.create.title'),
    createMessage: t('workspaceDialog.create.message'),
    createDetail: t('workspaceDialog.create.detail'),
    createConfirm: t('workspaceDialog.create.confirm'),
    createCancel: t('workspaceDialog.create.cancel')
  }
}

interface WorkspaceState {
  /** Absolute path of the currently open workspace, or null if none. */
  workspacePath: string | null
  /**
   * Absolute path of the user-tree root (`<workspace>/requests/`). Use this
   * everywhere the UI means "top of the user file tree" — create-at-root,
   * move-to-root, schema-import target, etc. `workspacePath` itself is the
   * meta-root and includes `.fetchpier/`, `environments/`, and future
   * top-level artifact buckets.
   */
  requestsRoot: string | null
  /** True while an open/create/load operation is in flight. */
  isLoading: boolean
  /** List of recent workspace paths (up to 5). */
  recentWorkspaces: string[]

  /** Open the OS folder-picker and activate the chosen workspace. */
  openWorkspace: () => Promise<void>
  /** Open the OS folder-picker (create-mode) and activate the chosen workspace. */
  createWorkspace: () => Promise<void>
  /** Clear the active workspace (does NOT delete any files). */
  closeWorkspace: () => void
  /** On app startup: restore the last used workspace if it still exists. */
  loadLastWorkspace: () => Promise<void>
  /** Open a specific workspace path directly (from recent list). */
  openRecentWorkspace: (workspacePath: string) => Promise<void>
}

async function applyWorkspace(path: string | null): Promise<{
  workspacePath: string | null
  requestsRoot: string | null
}> {
  if (!path) {
    useUiStateStore.getState().clear()
    useTreeStateStore.getState().clear()
    // REQ-0084: closing the workspace clears the open-tab session (empty state).
    teardownSession()
    return { workspacePath: null, requestsRoot: null }
  }
  // Eagerly hydrate the renderer's UI-state cache so openTab can stay sync.
  void useUiStateStore.getState().loadAll(path)
  // Hydrate the collection-tree expansion cache; the sidebar reconciles it
  // against the actual folder set once the tree loads.
  void useTreeStateStore.getState().load(path)
  // REQ-0084: restore the open-tab session for this workspace.
  void hydrateSession(path)
  try {
    const requestsRoot = await window.api.workspace.getRequestsRoot()
    return { workspacePath: path, requestsRoot }
  } catch (err) {
    console.error('[workspace] failed to resolve requestsRoot:', err)
    return { workspacePath: path, requestsRoot: null }
  }
}

/**
 * Save a pending appearance change before the open workspace changes, so it
 * lands in the workspace it was made for (REQ workspace color palettes §6.5).
 */
const flushAppearance = (): Promise<void> =>
  useAppearanceStore
    .getState()
    .flush()
    .catch(() => undefined)

export const useWorkspaceStore = create<WorkspaceState>()((set) => ({
  workspacePath: null,
  requestsRoot: null,
  isLoading: false,
  recentWorkspaces: [],

  openWorkspace: async () => {
    set({ isLoading: true })
    try {
      await flushAppearance()
      const path = await window.api.workspace.open(buildDialogStrings())
      if (path) {
        const [resolved, recent] = await Promise.all([
          applyWorkspace(path),
          window.api.workspace.getRecent()
        ])
        set({ ...resolved, recentWorkspaces: recent })
      }
    } finally {
      set({ isLoading: false })
    }
  },

  createWorkspace: async () => {
    set({ isLoading: true })
    try {
      await flushAppearance()
      const path = await window.api.workspace.create(buildDialogStrings())
      if (path) {
        const [resolved, recent] = await Promise.all([
          applyWorkspace(path),
          window.api.workspace.getRecent()
        ])
        set({ ...resolved, recentWorkspaces: recent })
      }
    } finally {
      set({ isLoading: false })
    }
  },

  closeWorkspace: () => {
    // REQ-0095: closing the workspace must tear the open tabs down too — leaving
    // them open without a workspace orphans them (no reliable save target). This
    // mirrors applyWorkspace(null).
    useUiStateStore.getState().clear()
    useTreeStateStore.getState().clear()
    teardownSession()
    set({ workspacePath: null, requestsRoot: null })
    // REQ menu coherence §6.7: release it in the process that owns the
    // filesystem too. Without this the session handle stayed bound and the
    // folder watcher kept running on the workspace the user just closed, so
    // every workspace-scoped operation still succeeded against it.
    void flushAppearance()
      .then(() => window.api.workspace.close())
      .catch((err) => {
        console.error('[workspace] failed to release the workspace in main:', err)
      })
  },

  loadLastWorkspace: async () => {
    set({ isLoading: true })
    try {
      const [result, recent] = await Promise.all([
        window.api.workspace.getLast(),
        window.api.workspace.getRecent()
      ])
      if (result.ok) {
        const resolved = await applyWorkspace(result.path)
        set({ ...resolved, recentWorkspaces: recent })
        return
      }
      // REQ-0122: the saved workspace is gone or is no longer a workspace. Main
      // wrote nothing into that folder and pruned the entry; say so, exactly as
      // opening a dead recent entry does. `'none'` is not a failure — there was
      // simply nothing to restore — so it stays silent.
      const resolved = await applyWorkspace(null)
      const refreshed = result.reason === 'none' ? recent : await reportFailedOpen(result.reason)
      set({ ...resolved, recentWorkspaces: refreshed })
    } catch {
      // If getLast fails for any reason, just start with no workspace
      set({ workspacePath: null, requestsRoot: null, recentWorkspaces: [] })
    } finally {
      set({ isLoading: false })
    }
  },

  openRecentWorkspace: async (workspacePath: string) => {
    set({ isLoading: true })
    try {
      await flushAppearance()
      const result = await window.api.workspace.openPath(workspacePath)
      if (result.ok) {
        const [resolved, recent] = await Promise.all([
          applyWorkspace(result.path),
          window.api.workspace.getRecent()
        ])
        set({ ...resolved, recentWorkspaces: recent })
      } else {
        // The path no longer points at a valid workspace; main pruned the stale
        // recent entry. Tell the user and refresh the (now shorter) recent list.
        set({ recentWorkspaces: await reportFailedOpen(result.reason) })
      }
    } finally {
      set({ isLoading: false })
    }
  }
}))
