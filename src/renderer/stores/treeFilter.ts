import { create } from 'zustand'

/**
 * The collection tree's filter: the query typed in the field above the tree, and
 * a pending request to focus that field (the "Filter sidebar" shortcut and menu
 * item). Runtime only; the tree clears the query when it unmounts (workspace
 * closed, sidebar hidden) and on workspace change.
 *
 * The focus request is a flag rather than an event because the tree may not be
 * mounted yet — the sidebar is unmounted while hidden — so the tree consumes it
 * on mount as well as when it changes.
 */
interface TreeFilterState {
  query: string
  setQuery: (query: string) => void
  focusRequested: boolean
  requestFocus: () => void
  consumeFocus: () => void
}

export const useTreeFilterStore = create<TreeFilterState>((set) => ({
  query: '',
  setQuery: (query) => set((s) => (s.query === query ? s : { query })),
  focusRequested: false,
  requestFocus: () => set({ focusRequested: true }),
  consumeFocus: () => set({ focusRequested: false })
}))
