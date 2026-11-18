import { create } from 'zustand'

/**
 * Last node the user clicked in the collection tree. There is no other notion of
 * "current position" in the sidebar, so the toolbar actions (import, new request,
 * new collection) read this to create inside the folder the user is looking at
 * instead of always defaulting to the requests root.
 */
interface TreeSelectionState {
  selectedPath: string | null
  selectedType: 'file' | 'folder' | null
  /**
   * Roving keyboard focus in the tree — the node the arrow keys / F2 / Delete act
   * on. Kept in sync with mouse clicks (clicking a node focuses it). Pruned when
   * the node disappears (external change, delete, move, rename).
   */
  focusedPath: string | null
  /**
   * The tree hides the open request's mark (tint and bar) after a deselect, as a
   * code editor's explorer drops the active file's highlight on an empty-area
   * click. It comes back when a request row is clicked or the active tab changes;
   * selecting a folder leaves it hidden (the folder is what is selected). Visual
   * only: the create/import target reads `selectedPath`, never this.
   */
  activeMarkHidden: boolean
  setSelected: (path: string, type: 'file' | 'folder') => void
  /** Set the roving keyboard focus (without changing the create/import selection). */
  setFocused: (path: string | null) => void
  /** Empty-area click or Escape on the tree: clear selection and focus, hide the open request's mark. */
  deselect: () => void
  /** The active tab changed: show the open request's mark again. */
  showActiveMark: () => void
  /** Reset everything (workspace change). */
  clear: () => void
  /**
   * Clear the selection if it points at `deletedAbsPath` or anything inside it.
   * Called synchronously after an in-app delete so a stale selection can't make
   * the next create/import target (and recreate) the now-deleted folder.
   */
  clearIfWithin: (deletedAbsPath: string) => void
  /**
   * Prune the selection when its path is no longer present in the live tree
   * (external delete, move, rename). Mirror of `treeState.reconcile`.
   */
  reconcile: (existingAbsPaths: string[]) => void
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/')
}

function isInside(child: string, root: string): boolean {
  const c = normalize(child)
  const r = normalize(root)
  return c === r || c.startsWith(`${r}/`)
}

export const useTreeSelectionStore = create<TreeSelectionState>((set) => ({
  selectedPath: null,
  selectedType: null,
  focusedPath: null,
  activeMarkHidden: false,
  // Clicking a node both selects it (for toolbar create/import targeting) and
  // focuses it (so the keyboard keeps acting on what the user just clicked).
  // Only a request click brings the open request's mark back after a deselect.
  setSelected: (selectedPath, selectedType) =>
    set((s) => ({
      selectedPath,
      selectedType,
      focusedPath: selectedPath,
      activeMarkHidden: selectedType === 'file' ? false : s.activeMarkHidden
    })),
  setFocused: (focusedPath) => set({ focusedPath }),
  deselect: () =>
    set({ selectedPath: null, selectedType: null, focusedPath: null, activeMarkHidden: true }),
  showActiveMark: () => set((s) => (s.activeMarkHidden ? { activeMarkHidden: false } : s)),
  clear: () =>
    set({ selectedPath: null, selectedType: null, focusedPath: null, activeMarkHidden: false }),
  clearIfWithin: (deletedAbsPath) =>
    set((s) => {
      const patch: Partial<TreeSelectionState> = {}
      if (s.selectedPath && isInside(s.selectedPath, deletedAbsPath)) {
        patch.selectedPath = null
        patch.selectedType = null
      }
      if (s.focusedPath && isInside(s.focusedPath, deletedAbsPath)) patch.focusedPath = null
      return Object.keys(patch).length ? patch : s
    }),
  reconcile: (existingAbsPaths) =>
    set((s) => {
      if (!s.selectedPath && !s.focusedPath) return s
      const live = new Set(existingAbsPaths.map(normalize))
      const patch: Partial<TreeSelectionState> = {}
      if (s.selectedPath && !live.has(normalize(s.selectedPath))) {
        patch.selectedPath = null
        patch.selectedType = null
      }
      if (s.focusedPath && !live.has(normalize(s.focusedPath))) patch.focusedPath = null
      return Object.keys(patch).length ? patch : s
    })
}))

function parentOf(p: string): string | null {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return idx > 0 ? p.slice(0, idx) : null
}

/**
 * Resolve where a toolbar create/import should land, given the current selection:
 * - a selected folder → that folder
 * - a selected file → its parent folder
 * - nothing selected, or a selection outside `requestsRoot` → `requestsRoot`
 */
export function resolveTargetFolder(
  requestsRoot: string,
  selectedPath: string | null,
  selectedType: 'file' | 'folder' | null
): string {
  if (!requestsRoot || !selectedPath || !isInside(selectedPath, requestsRoot)) {
    return requestsRoot
  }
  if (selectedType === 'folder') return selectedPath
  if (selectedType === 'file') {
    const parent = parentOf(selectedPath)
    return parent && isInside(parent, requestsRoot) ? parent : requestsRoot
  }
  return requestsRoot
}
