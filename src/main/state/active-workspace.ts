import { workspace } from '@fetchpier/core'
import { setMenuWorkspaceOpen } from '../menu/state'

// The session's single source of truth for "which workspace is open" is the
// workspace handle (REQ Core-owned workspace handle, F8). The former string
// pointer (`activeWorkspacePath`) is gone — every consumer reads the handle (or
// `handle.path` when it needs the raw string). The adapter still owns this
// per-session pointer; it is just typed as the handle now.
let activeHandle: workspace.Workspace | null = null

/**
 * Open (or clear) the active workspace handle for the session.
 *
 * This is the single writer of the handle — every activation path and the close
 * path funnel through it — so it is also where the menu learns whether a
 * workspace is open. Reporting it from the four call sites instead would be
 * four chances to forget one (REQ menu coherence §6.2).
 */
export function setActiveWorkspace(workspacePath: string | null): void {
  activeHandle = workspacePath ? workspace.openWorkspace(workspacePath) : null
  setMenuWorkspaceOpen(activeHandle !== null)
}

/** The handle for the active workspace, or `null` when none is open. */
export function getActiveWorkspaceHandle(): workspace.Workspace | null {
  return activeHandle
}

/** The handle for the active workspace; throws when none is open. */
export function requireActiveWorkspaceHandle(): workspace.Workspace {
  if (!activeHandle) {
    throw new Error('No active workspace')
  }
  return activeHandle
}
