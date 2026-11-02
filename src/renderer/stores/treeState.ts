import { create } from 'zustand'

const WRITE_DEBOUNCE_MS = 400

/**
 * Normalise an absolute path to a workspace-relative, forward-slash path. Mirror
 * of `toRelPath` in `CollectionTree.tsx`; kept here so the store can key folders
 * portably (relative paths survive the workspace being moved across machines).
 */
export function toRel(absPath: string, workspacePath: string | null): string {
  if (!workspacePath) return absPath.replace(/\\/g, '/')
  if (absPath.startsWith(workspacePath)) {
    return absPath
      .slice(workspacePath.length)
      .replace(/^[/\\]/, '')
      .replace(/\\/g, '/')
  }
  return absPath.replace(/\\/g, '/')
}

interface TreeStateStore {
  /** Workspace the cache is loaded for (drives `toRel`). */
  workspacePath: string | null
  /** Expanded folders as workspace-relative `/`-paths. Replaced (never mutated). */
  expanded: Set<string>
  /** True once `read()` has resolved. Until then, every folder reads as open. */
  ready: boolean
  /**
   * Set when `read()` returned `null` (first run, no file). The next `reconcile`
   * seeds the expanded set with every existing folder, preserving the historical
   * "everything open by default" behaviour.
   */
  seedPending: boolean
  /** Folder paths from a `reconcile` that arrived before `load` resolved. */
  pendingFolderPaths: string[] | null
  /** Expandable-request paths from a `reconcile` that arrived before `load`. */
  pendingExpandablePaths: string[] | null
  /** Relative keys of every folder in the live tree (drives `expandAll`). */
  lastFolderKeys: string[]

  /** Read persisted state from main for `workspacePath`. */
  load: (workspacePath: string) => Promise<void>
  /** Drop all in-memory state (workspace close / switch). */
  clear: () => void
  /** Whether a folder / instance-parent is expanded. Returns `true` while not `ready`. */
  isExpanded: (absPath: string) => boolean
  /** Expand/collapse a folder / instance-parent and persist (debounced). */
  setExpanded: (absPath: string, open: boolean) => void
  /**
   * Reconcile the persisted set against what currently exists:
   * - **seed** on first run with the folders only (historical "folders open by
   *   default"; instance-parents start collapsed),
   * - otherwise **prune** entries whose key is no longer a valid expandable node
   *   (a folder OR an instance-bearing request). Persists only when changed.
   *
   * `expandableAbsPaths` are the requests that currently have instance children;
   * they count as valid keys for pruning but are NOT seeded open.
   */
  reconcile: (folderAbsPaths: string[], expandableAbsPaths?: string[]) => void
  /** Collapse every folder/instance-parent (clear the expanded set) and persist. */
  collapseAll: () => void
  /** Expand every folder currently in the tree and persist. */
  expandAll: () => void
}

let writeTimer: ReturnType<typeof setTimeout> | null = null

function scheduleWrite(getExpanded: () => Set<string>): void {
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = setTimeout(() => {
    writeTimer = null
    void window.api.treeState.write([...getExpanded()]).catch((err) => {
      console.error('[tree-state] write failed:', err)
    })
  }, WRITE_DEBOUNCE_MS)
}

export const useTreeStateStore = create<TreeStateStore>()((set, get) => ({
  workspacePath: null,
  expanded: new Set(),
  ready: false,
  seedPending: false,
  pendingFolderPaths: null,
  pendingExpandablePaths: null,
  lastFolderKeys: [],

  load: async (workspacePath) => {
    if (writeTimer) {
      clearTimeout(writeTimer)
      writeTimer = null
    }
    set({
      workspacePath,
      expanded: new Set(),
      ready: false,
      seedPending: false,
      pendingFolderPaths: null,
      pendingExpandablePaths: null
    })
    try {
      const remote = await window.api.treeState.read()
      // Ignore a stale resolution if the workspace changed mid-flight.
      if (get().workspacePath !== workspacePath) return
      if (remote === null) {
        set({ seedPending: true, ready: true })
      } else {
        set({ expanded: new Set(remote), ready: true })
      }
      const pending = get().pendingFolderPaths
      if (pending) {
        const pendingExpandable = get().pendingExpandablePaths ?? []
        set({ pendingFolderPaths: null, pendingExpandablePaths: null })
        get().reconcile(pending, pendingExpandable)
      }
    } catch (err) {
      console.error('[tree-state] load failed:', err)
      set({ ready: true })
    }
  },

  clear: () => {
    if (writeTimer) {
      clearTimeout(writeTimer)
      writeTimer = null
    }
    set({
      workspacePath: null,
      expanded: new Set(),
      ready: false,
      seedPending: false,
      pendingFolderPaths: null,
      pendingExpandablePaths: null
    })
  },

  isExpanded: (absPath) => {
    const { ready, expanded, workspacePath } = get()
    if (!ready) return true
    return expanded.has(toRel(absPath, workspacePath))
  },

  setExpanded: (absPath, open) => {
    const { expanded, workspacePath } = get()
    const key = toRel(absPath, workspacePath)
    if (open === expanded.has(key)) return
    const next = new Set(expanded)
    if (open) next.add(key)
    else next.delete(key)
    set({ expanded: next })
    scheduleWrite(() => get().expanded)
  },

  reconcile: (folderAbsPaths, expandableAbsPaths = []) => {
    const { ready, seedPending, expanded, workspacePath } = get()
    if (!ready) {
      set({ pendingFolderPaths: folderAbsPaths, pendingExpandablePaths: expandableAbsPaths })
      return
    }

    // Remember every folder key so `expandAll` can open them without the tree.
    set({ lastFolderKeys: folderAbsPaths.map((p) => toRel(p, workspacePath)) })

    if (seedPending) {
      // Seed folders open by default; instance-parents start collapsed.
      const seed = new Set(folderAbsPaths.map((p) => toRel(p, workspacePath)))
      set({ expanded: seed, seedPending: false })
      scheduleWrite(() => get().expanded)
      return
    }

    // Prune entries that are no longer a valid expandable node (a folder OR an
    // instance-bearing request).
    const valid = new Set(
      [...folderAbsPaths, ...expandableAbsPaths].map((p) => toRel(p, workspacePath))
    )
    let changed = false
    const next = new Set<string>()
    for (const key of expanded) {
      if (valid.has(key)) next.add(key)
      else changed = true
    }
    if (changed) {
      set({ expanded: next })
      scheduleWrite(() => get().expanded)
    }
  },

  collapseAll: () => {
    if (get().expanded.size === 0) return
    set({ expanded: new Set() })
    scheduleWrite(() => get().expanded)
  },

  expandAll: () => {
    set({ expanded: new Set(get().lastFolderKeys) })
    scheduleWrite(() => get().expanded)
  }
}))
