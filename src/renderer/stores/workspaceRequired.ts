import { create } from 'zustand'
import { useWorkspaceStore } from './workspace'

/**
 * "This needs a workspace" — the prompt that replaces the silent no-op.
 *
 * A request can be composed before a workspace exists (REQ menu coherence
 * §6.1), so saving one has to lead somewhere. Before this, saving with no
 * workspace open did nothing at all from the editor and the shortcut, and the
 * unsaved-changes prompt dropped the tab's contents without a word.
 *
 * Same shape as `unsavedGuard`: the caller parks a continuation, a modal
 * rendered once in `AppLayout` resolves it, and cancelling simply drops it.
 *
 * REQ Application menu coherence on macOS §6.11.
 */

interface PendingWorkspaceRequest {
  /** Runs once a workspace is established. Never runs if the user cancels. */
  onProceed: () => void | Promise<void>
}

interface WorkspaceRequiredState {
  pending: PendingWorkspaceRequest | null
  request: (pending: PendingWorkspaceRequest) => void
  clear: () => void
}

export const useWorkspaceRequiredStore = create<WorkspaceRequiredState>()((set) => ({
  pending: null,
  request: (pending) => set({ pending }),
  clear: () => set({ pending: null })
}))

/**
 * Run `proceed` with a workspace guaranteed to be open. With one already open
 * it runs immediately; otherwise the user is asked to open or create one first,
 * and `proceed` runs only if they do.
 */
export async function withWorkspace(proceed: () => void | Promise<void>): Promise<void> {
  if (useWorkspaceStore.getState().workspacePath) {
    await proceed()
    return
  }
  useWorkspaceRequiredStore.getState().request({ onProceed: proceed })
}
