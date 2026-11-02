import { create } from 'zustand'
import type { RequestUiState, RequestUiStateMap } from '../../shared/types'

const WRITE_DEBOUNCE_MS = 500

interface UiStateStore {
  /** Cached on-disk map. Keys are request UUIDs (`# @id`). */
  map: RequestUiStateMap
  /** True between the start of a `loadAll` call and its resolution. */
  isLoading: boolean
  /** Workspace path the cache was loaded for. Null when no workspace is active. */
  loadedFor: string | null

  /**
   * Eagerly load the full map for a workspace. Called once per workspace
   * activation so subsequent `get(requestId)` reads stay synchronous. Merges
   * with any optimistic local writes so racing clicks during the load are
   * preserved.
   */
  loadAll: (workspacePath: string) => Promise<void>

  /** Drop all in-memory state. Called on workspace close. */
  clear: () => void

  /** Synchronous lookup. Returns `null` if no entry is cached. */
  get: (requestId: string) => RequestUiState | null

  /**
   * Merge `partial` into the cache for `requestId` and schedule a debounced
   * write to main. Returns the merged entry. Multiple calls within the
   * debounce window coalesce into a single IPC `ui-state:write`.
   */
  setForRequest: (requestId: string, partial: RequestUiState) => RequestUiState

  /** Update the cache from a `ui-state:changed` broadcast (no re-write). */
  applyExternal: (requestId: string, state: RequestUiState | null) => void

  /** Test-only: replace internal state. */
  _setMap: (next: RequestUiStateMap) => void
}

// Per-request debounce timers. Module-level so re-mounts don't drop them.
const writeTimers = new Map<string, ReturnType<typeof setTimeout>>()
const pendingWrites = new Map<string, RequestUiState>()

function scheduleWrite(requestId: string, snapshot: RequestUiState): void {
  pendingWrites.set(requestId, snapshot)
  const existing = writeTimers.get(requestId)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    const payload = pendingWrites.get(requestId)
    writeTimers.delete(requestId)
    pendingWrites.delete(requestId)
    if (!payload) return
    void window.api.uiState.write(requestId, payload).catch((err) => {
      console.error('[ui-state] write failed:', err)
    })
  }, WRITE_DEBOUNCE_MS)
  writeTimers.set(requestId, timer)
}

export const useUiStateStore = create<UiStateStore>()((set, get) => ({
  map: {},
  isLoading: false,
  loadedFor: null,

  loadAll: async (workspacePath) => {
    set({ isLoading: true })
    try {
      const remote = await window.api.uiState.readAll()
      // Preserve any optimistic local writes that happened during the load.
      set((state) => ({
        map: { ...remote, ...state.map },
        loadedFor: workspacePath,
        isLoading: false
      }))
    } catch (err) {
      console.error('[ui-state] loadAll failed:', err)
      set({ isLoading: false })
    }
  },

  clear: () => {
    for (const timer of writeTimers.values()) clearTimeout(timer)
    writeTimers.clear()
    pendingWrites.clear()
    set({ map: {}, loadedFor: null })
  },

  get: (requestId) => {
    if (!requestId) return null
    return get().map[requestId] ?? null
  },

  setForRequest: (requestId, partial) => {
    if (!requestId) return partial
    const current = get().map[requestId] ?? {}
    const merged: RequestUiState = { ...current, ...partial }
    set((state) => ({ map: { ...state.map, [requestId]: merged } }))
    scheduleWrite(requestId, merged)
    return merged
  },

  applyExternal: (requestId, state) => {
    if (!requestId) return
    set((s) => {
      const next = { ...s.map }
      if (state === null || Object.keys(state).length === 0) {
        delete next[requestId]
      } else {
        next[requestId] = state
      }
      return { map: next }
    })
  },

  _setMap: (next) => set({ map: next })
}))

// Module-level subscription to main's broadcast. Multi-window-safe: every
// renderer with this store mounted receives updates from any other window's
// writes.
if (typeof window !== 'undefined' && window.api?.uiState?.onChanged) {
  window.api.uiState.onChanged(({ requestId, state }) => {
    useUiStateStore.getState().applyExternal(requestId, state)
  })
}
