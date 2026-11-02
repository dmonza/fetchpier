import { create } from 'zustand'
import type { Tab } from '../../shared/types'
import { computeTabDirty } from '../lib/tab-dirty'

/**
 * Shared unsaved-edit guard (REQ-0095). A single coordinator so every flow that
 * would drop tabs — window/app close, workspace switch, close workspace, and the
 * bulk-close / rename-move tab actions — routes its modified tabs through the
 * same save/discard/cancel prompt instead of discarding them silently.
 */
interface PendingGuard {
  /** The modified tabs to present in the prompt. */
  tabs: Tab[]
  /** Runs after the user chooses Save or Discard (e.g. close the window, switch workspace). */
  onProceed: () => Promise<void>
}

interface UnsavedGuardState {
  pending: PendingGuard | null
  request: (tabs: Tab[], onProceed: () => Promise<void>) => void
  clear: () => void
}

export const useUnsavedGuardStore = create<UnsavedGuardState>()((set) => ({
  pending: null,
  request: (tabs, onProceed) => set({ pending: { tabs, onProceed } }),
  clear: () => set({ pending: null })
}))

/**
 * Run `proceed` unless any of `affectedTabs` has unsaved edits, in which case the
 * modified ones are presented in the prompt first and `proceed` runs only after
 * the user saves or discards (it is aborted on cancel).
 *
 * The dirty check is **synchronous** (`computeTabDirty`) so a still-pending
 * debounced reconcile can never hide a real edit from the guard (REQ-0095 safety
 * invariant). Read-only / history tabs are never guarded.
 */
export async function guardDiscard(
  affectedTabs: Tab[],
  proceed: () => Promise<void>
): Promise<void> {
  const dirty = affectedTabs.filter((t) => !t.isReadOnly && computeTabDirty(t))
  if (dirty.length === 0) {
    await proceed()
    return
  }
  useUnsavedGuardStore.getState().request(dirty, proceed)
}
