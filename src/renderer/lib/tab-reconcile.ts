import type { Tab } from '../../shared/types'

/**
 * Open-tab reconciliation against external filesystem changes (REQ
 * open-tab-file-reconciliation). Pure, synchronous decision helpers — no React,
 * no IPC, no store access — so the policy is unit-testable in isolation. The hook
 * `useFileSyncReconciliation` wires these to the watcher signals and the store.
 */

/** How an open tab reacts when its backing file changes content on disk. */
export type ContentReconcileAction =
  /** Lazy tab never loaded into the editor — nothing in memory; parses fresh on activation. */
  | 'skip'
  /** The on-disk content matches our captured baseline — the app's own write (or no real change). */
  | 'noop'
  /** Clean tab — adopt the new on-disk content. */
  | 'reload'
  /** Modified tab — flag a conflict; never silently overwrite. */
  | 'conflict'

/**
 * Decide how a tab responds to an external content change of its file. The
 * baseline equality check (`newHash === cleanHash`) suppresses the app's own
 * writes: a save pins `cleanHash` to exactly the bytes it wrote, so re-reading
 * that same file re-serializes to the identical hash.
 */
export function reconcileContentChange(args: {
  cleanHash: string | undefined
  newHash: string
  isDirty: boolean
}): ContentReconcileAction {
  if (args.cleanHash === undefined) return 'skip'
  if (args.newHash === args.cleanHash) return 'noop'
  return args.isDirty ? 'conflict' : 'reload'
}

/**
 * Given the set of every request path currently present in the workspace tree,
 * compute which open tabs must flip their `removedOnDisk` flag. A file-backed tab
 * whose path is absent from the tree was moved/removed externally → flag it; one
 * whose path reappears (e.g. after a deliberate re-persist) → clear it. Paths
 * mid-flight in an in-app rename/move are skipped so a self-initiated move is
 * never mistaken for an external removal.
 */
export function removedFlagChanges(
  tabs: Pick<Tab, 'id' | 'filePath' | 'removedOnDisk'>[],
  treePaths: Set<string>,
  isRepointing: (path: string) => boolean
): { id: string; removedOnDisk: boolean }[] {
  const changes: { id: string; removedOnDisk: boolean }[] = []
  for (const t of tabs) {
    if (t.filePath == null) continue
    if (isRepointing(t.filePath)) continue
    const gone = !treePaths.has(t.filePath)
    if (gone && !t.removedOnDisk) changes.push({ id: t.id, removedOnDisk: true })
    else if (!gone && t.removedOnDisk) changes.push({ id: t.id, removedOnDisk: false })
  }
  return changes
}
