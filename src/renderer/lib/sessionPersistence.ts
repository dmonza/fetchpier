import { useRequestStore } from '../stores/request'
import type { WorkspaceSessionTab } from '../../shared/types'

/**
 * Tab-session persistence (REQ-0084). Bridges the renderer's request store and
 * the main-process workspace-state store:
 *
 * - On workspace open, {@link hydrateSession} reads the reconciled session and
 *   restores the file-backed request tabs.
 * - Afterwards, a single store subscription writes the live session back
 *   (debounced in main) whenever the set of file-backed tabs, their order, or
 *   the active tab changes. Content edits do not trigger a write — only the
 *   session *shape* does, tracked via a signature.
 *
 * Only file-backed request tabs are persisted; untitled and history-record tabs
 * are excluded (they stay open in the live session, they are simply not written).
 */

let ready = false
let currentWorkspace: string | null = null
let lastSignature = ''

interface LiveSession {
  tabs: WorkspaceSessionTab[]
  activeTabIndex: number
}

function computeSession(state: ReturnType<typeof useRequestStore.getState>): LiveSession {
  const fileTabs = state.tabs.filter(
    (t) => t.filePath && !t.isReadOnly && !t.historyEntryId && t.rawContent == null
  )
  const tabs: WorkspaceSessionTab[] = fileTabs.map((t) => ({
    kind: 'request',
    path: t.filePath as string,
    // Persist only the non-default mode (preview / pinned) so a permanent tab
    // stays marker-free and the change signature stays clean.
    ...(t.mode === 'preview' || t.mode === 'pinned' ? { mode: t.mode } : {})
  }))
  const activeTabIndex = state.activeTabId
    ? fileTabs.findIndex((t) => t.id === state.activeTabId)
    : -1
  return { tabs, activeTabIndex }
}

// Install the write subscription once. It is gated on `ready` so the restore in
// `hydrateSession` (which runs with `ready === false`) never writes the seed
// back to disk.
useRequestStore.subscribe((state) => {
  if (!ready || !currentWorkspace) return
  const session = computeSession(state)
  const signature = JSON.stringify(session)
  if (signature === lastSignature) return
  lastSignature = signature
  window.api.workspaceState.setSession(session).catch(console.error)
})

/** Read and restore the persisted session for `workspacePath`. */
export async function hydrateSession(workspacePath: string): Promise<void> {
  ready = false
  currentWorkspace = workspacePath
  try {
    const view = await window.api.workspaceState.read()
    useRequestStore.getState().restoreSession(
      view.session.tabs.map((t) => ({ path: t.path, mode: t.mode })),
      view.session.activeTabIndex
    )
  } catch (err) {
    console.error('[session] failed to restore session:', err)
    useRequestStore.getState().restoreSession([], -1)
  }
  // Seed the signature with the just-restored session so the first post-restore
  // change is what triggers the next write (not the restore itself).
  lastSignature = JSON.stringify(computeSession(useRequestStore.getState()))
  ready = true
}

/** Detach from the current workspace and clear the live tab set. */
export function teardownSession(): void {
  ready = false
  currentWorkspace = null
  lastSignature = ''
  useRequestStore.getState().restoreSession([], -1)
}
