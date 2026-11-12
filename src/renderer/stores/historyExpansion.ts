// Per-session UI state for the activity-panel's request-history row expansion
// (REQ-0069). Tracks which rows are expanded, caches the parsed
// `ActivityLogFile` for each expanded run, and records the most recent fetch
// error per id so the expanded area can render an inline retry state.
//
// Why this is a separate store (not `useActivityPanelStore`):
//   - the activity-panel store is persisted to AppSettings; this state must
//     not survive across app restarts (REQ-0069 §6.1, §2.2);
//   - the lifecycles differ: expansion resets when the workspace changes;
//     activity-panel chrome (height, active tab, detached) does not.
//
// Each window owns its own expansion state (docked and popout do not sync).

import { create } from 'zustand'
import type { ActivityLogFile } from '../../shared/lib/activity-log'

export interface HistoryExpansionState {
  expandedIds: ReadonlySet<string>
  cache: ReadonlyMap<string, ActivityLogFile>
  fetchErrors: ReadonlyMap<string, string>

  isExpanded: (id: string) => boolean
  toggle: (id: string) => void
  expand: (id: string) => void
  collapse: (id: string) => void

  setParsed: (id: string, file: ActivityLogFile) => void
  setError: (id: string, message: string) => void
  clearError: (id: string) => void
  /** Drop the cached entry (e.g. on `history:changed` if the same id was rewritten). */
  invalidate: (id: string) => void
  /** Reset everything — call when the workspace switches. */
  reset: () => void
}

export const useHistoryExpansionStore = create<HistoryExpansionState>()((set, get) => ({
  expandedIds: new Set<string>(),
  cache: new Map<string, ActivityLogFile>(),
  fetchErrors: new Map<string, string>(),

  isExpanded: (id) => get().expandedIds.has(id),

  toggle: (id) =>
    set((s) => {
      const next = new Set(s.expandedIds)
      if (next.has(id)) {
        next.delete(id)
        // REQ-0104: evict on collapse — see `collapse` below for why.
        const cache = new Map(s.cache)
        cache.delete(id)
        const fetchErrors = new Map(s.fetchErrors)
        fetchErrors.delete(id)
        return { expandedIds: next, cache, fetchErrors }
      }
      next.add(id)
      return { expandedIds: next }
    }),

  expand: (id) =>
    set((s) => {
      if (s.expandedIds.has(id)) return {}
      const next = new Set(s.expandedIds)
      next.add(id)
      return { expandedIds: next }
    }),

  collapse: (id) =>
    set((s) => {
      if (!s.expandedIds.has(id)) return {}
      const next = new Set(s.expandedIds)
      next.delete(id)
      // REQ-0104: a collapsed row's cached run (and any fetch error) is
      // released — re-expanding re-fetches. Without this, every run ever
      // expanded in the session stays retained in full for its lifetime.
      const cache = new Map(s.cache)
      cache.delete(id)
      const fetchErrors = new Map(s.fetchErrors)
      fetchErrors.delete(id)
      return { expandedIds: next, cache, fetchErrors }
    }),

  setParsed: (id, file) =>
    set((s) => {
      const cache = new Map(s.cache)
      cache.set(id, file)
      const fetchErrors = new Map(s.fetchErrors)
      fetchErrors.delete(id)
      return { cache, fetchErrors }
    }),

  setError: (id, message) =>
    set((s) => {
      const fetchErrors = new Map(s.fetchErrors)
      fetchErrors.set(id, message)
      return { fetchErrors }
    }),

  clearError: (id) =>
    set((s) => {
      if (!s.fetchErrors.has(id)) return {}
      const fetchErrors = new Map(s.fetchErrors)
      fetchErrors.delete(id)
      return { fetchErrors }
    }),

  invalidate: (id) =>
    set((s) => {
      const hadCache = s.cache.has(id)
      const hadErr = s.fetchErrors.has(id)
      if (!hadCache && !hadErr) return {}
      const cache = new Map(s.cache)
      cache.delete(id)
      const fetchErrors = new Map(s.fetchErrors)
      fetchErrors.delete(id)
      return { cache, fetchErrors }
    }),

  reset: () =>
    set({
      expandedIds: new Set<string>(),
      cache: new Map<string, ActivityLogFile>(),
      fetchErrors: new Map<string, string>()
    })
}))
