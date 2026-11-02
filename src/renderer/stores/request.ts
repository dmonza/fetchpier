import { create } from 'zustand'
import type { Tab, TabMode, RequestEditorState } from '../../shared/types'
import { DEFAULT_REQUEST_STATE } from '../../shared/types'
import { basenameOfPath } from '../lib/path'
import { computeTabDirty, cleanHashOf } from '../lib/tab-dirty'
import {
  pinTab as pinTabOrder,
  unpinTab as unpinTabOrder,
  reorderClamped,
  closeRightIds,
  closeLeftIds,
  closeOthersIds,
  closeAllIds,
  regroup
} from '../lib/tab-order'
import { bumpMru, pruneMru } from '../lib/tab-mru'

let nextId = 1

// REQ-0095: a tab is modified when its serialized content diverges from its
// captured baseline (or it holds a malformed param). Setting modified is
// immediate on edit; *clearing* it (detecting a revert to baseline) is the only
// costly step (serialize + hash) and is debounced so editing a large body stays
// O(1) per keystroke. The window only ever over-reports modified, never under —
// the guards read `computeTabDirty` synchronously and so are never fooled.
const RECONCILE_DEBOUNCE_MS = 400
const reconcileTimers = new Map<string, ReturnType<typeof setTimeout>>()

function cancelReconcile(id: string): void {
  const timer = reconcileTimers.get(id)
  if (timer) {
    clearTimeout(timer)
    reconcileTimers.delete(id)
  }
}

function cancelReconcilesExcept(keepIds: Set<string>): void {
  for (const id of [...reconcileTimers.keys()]) {
    if (!keepIds.has(id)) cancelReconcile(id)
  }
}

/** Slice of state the close-set helper reads and rewrites. */
type CloseSlice = { tabs: Tab[]; activeTabId: string | null; mruIds: string[] }

/**
 * Close every tab in `ids`, keeping `anchorId` active (used by close-to-the-right
 * / left, which always spare the anchor and pinned tabs). Prunes reconcile timers
 * and the MRU list; if the active tab is among those closing, focus falls to the
 * anchor.
 */
function closeTabSet(state: CloseSlice, ids: string[], anchorId: string): CloseSlice {
  if (ids.length === 0) return state
  const closeSet = new Set(ids)
  for (const id of ids) cancelReconcile(id)
  const remaining = state.tabs.filter((t) => !closeSet.has(t.id))
  const nextActive =
    state.activeTabId && closeSet.has(state.activeTabId) ? anchorId : state.activeTabId
  const mruIds = bumpMru(pruneMru(state.mruIds, new Set(remaining.map((t) => t.id))), nextActive)
  return { tabs: remaining, activeTabId: nextActive, mruIds }
}

/** True for a normal, editable tab that should track a clean baseline. */
function isEditableTab(tab: Tab): boolean {
  return !tab.isReadOnly && tab.rawContent === undefined && tab.historyEntryId === undefined
}

function createTab(overrides?: Partial<Tab>): Tab {
  const tab: Tab = {
    id: String(nextId++),
    title: 'Untitled',
    filePath: null,
    isDirty: false,
    request: { ...DEFAULT_REQUEST_STATE },
    response: null,
    isLoading: false,
    error: null,
    requestId: crypto.randomUUID(),
    mode: 'permanent',
    ...overrides
  }
  // A brand-new untitled tab seeds its baseline from the default request so an
  // untouched tab is clean and a fully-reverted edit returns to clean. A
  // file-backed tab leaves `cleanHash` undefined until its content is loaded
  // (the load effect calls markClean).
  if (tab.cleanHash === undefined && tab.filePath === null && isEditableTab(tab)) {
    tab.cleanHash = cleanHashOf(tab)
  }
  return tab
}

interface RequestState {
  tabs: Tab[]
  activeTabId: string | null
  /**
   * Tab ids in most-recently-used order (index 0 = most recent). Drives Ctrl+Tab
   * MRU switching. Maintained whenever the active tab changes; pruned on close.
   */
  mruIds: string[]
  openTab: (tab?: Partial<Tab>) => void
  /**
   * Open a request in the single **preview** slot (REQ-0085). Given a file-backed
   * request path: focus an existing permanent tab for it (no preview created);
   * keep the current preview focused if it already shows the path; otherwise
   * replace the current preview **in place** (same tab-bar position) or, if none
   * exists, create a new preview tab. Always file-backed — never untitled.
   */
  openPreviewTab: (overrides: { title?: string; filePath: string }) => void
  /** Promote a preview tab to permanent (drop the ephemeral italic state). Idempotent. */
  promoteTab: (id: string) => void
  closeTab: (id: string) => void
  closeOtherTabs: (id: string) => void
  closeAllTabs: () => void
  /** Close every tab positioned after `id` in the bar, sparing pinned tabs. */
  closeTabsToRight: (id: string) => void
  /** Close every tab positioned before `id` in the bar, sparing pinned tabs. */
  closeTabsToLeft: (id: string) => void
  /** Pin a tab: group it at the front and promote it out of preview. Idempotent. */
  pinTab: (id: string) => void
  /** Unpin a tab: move it to the front of the unpinned group. Idempotent. */
  unpinTab: (id: string) => void
  reorderTabs: (fromId: string, toId: string) => void
  /**
   * Re-point open tabs to follow an in-app rename/move (REQ
   * open-tab-file-reconciliation). For every tab whose `filePath` equals a
   * mapping's `oldPath`, update `filePath` and `title` to the new location and
   * clear any stale removed-on-disk / conflict flag. The tab id is preserved so
   * the in-memory buffer, dirty state, and baseline survive — the editor does not
   * re-read the file on a path change. Runs synchronously in the in-app handler so
   * the subsequent watcher broadcast resolves to a no-op for these tabs (a
   * self-initiated move is never mistaken for an external removal).
   */
  repointTabs: (mappings: { oldPath: string; newPath: string }[]) => void
  setActiveTab: (id: string) => void
  /**
   * Activate a tab **without** touching the MRU order — used while cycling through
   * tabs with Ctrl held (the cycle walks a frozen snapshot; the MRU is only
   * re-ordered once, when Ctrl is released, via {@link setActiveTab}).
   */
  cycleActiveTab: (id: string) => void
  updateTab: (id: string, changes: Partial<Tab>) => void
  updateRequest: (id: string, request: Partial<RequestEditorState>) => void
  /**
   * Capture a clean baseline for the tab (REQ-0095). Called after a request is
   * loaded into a tab and after each save; cancels any pending revert-detection.
   *
   * `baselineHash` pins the baseline to a **known** serialized content — the save
   * path passes the hash of exactly what it wrote, so an edit made while the write
   * was in flight is preserved as still-modified instead of being silently
   * swallowed (the TOCTOU). Omitted (the load path) baselines against the tab's
   * current content. The tab is modified iff its live content diverges from the
   * baseline or it still holds a malformed param.
   */
  markClean: (id: string, baselineHash?: string) => void
  /**
   * Replace the whole tab set with a restored session (REQ-0084). Each entry is
   * a file-backed request tab; its `.http` content and stable `requestId` load
   * lazily on activation, exactly like opening from the tree. `activeIndex` of
   * `-1` (or out of range) leaves no active tab. A `preview` entry is restored as
   * a preview tab (REQ-0085); at most one preview survives (the first wins).
   */
  restoreSession: (
    tabs: { path: string; mode?: 'preview' | 'pinned' }[],
    activeIndex: number
  ) => void
}

export const useRequestStore = create<RequestState>()((set) => {
  // Debounced revert-detection: after the user stops editing, recompute the
  // modified flag for `id`. This is the only place modified flips back to false.
  const scheduleReconcile = (id: string): void => {
    cancelReconcile(id)
    const timer = setTimeout(() => {
      reconcileTimers.delete(id)
      set((state) => {
        const tab = state.tabs.find((t) => t.id === id)
        if (!tab) return state
        const dirty = computeTabDirty(tab)
        if (dirty === tab.isDirty) return state
        return { tabs: state.tabs.map((t) => (t.id === id ? { ...t, isDirty: dirty } : t)) }
      })
    }, RECONCILE_DEBOUNCE_MS)
    reconcileTimers.set(id, timer)
  }

  return {
    // REQ-0084: no one-tab floor. The app starts with zero tabs (empty state) and
    // the session is restored on workspace open.
    tabs: [],
    activeTabId: null,
    mruIds: [],

    openTab: (overrides) =>
      set((state) => {
        // If a tab with this historyEntryId already exists, just activate it
        if (overrides?.historyEntryId) {
          const existing = state.tabs.find((t) => t.historyEntryId === overrides.historyEntryId)
          if (existing) {
            return { activeTabId: existing.id, mruIds: bumpMru(state.mruIds, existing.id) }
          }
        }
        // If a tab with this filePath already exists, just activate it
        if (overrides?.filePath) {
          const existing = state.tabs.find((t) => t.filePath === overrides.filePath)
          if (existing) {
            return { activeTabId: existing.id, mruIds: bumpMru(state.mruIds, existing.id) }
          }
        }
        const tab = createTab(overrides)
        return {
          tabs: [...state.tabs, tab],
          activeTabId: tab.id,
          mruIds: bumpMru(state.mruIds, tab.id)
        }
      }),

    openPreviewTab: ({ title, filePath }) =>
      set((state) => {
        // Already open as a non-preview tab → focus it; never spawn a preview.
        const permanent = state.tabs.find((t) => t.filePath === filePath && t.mode !== 'preview')
        if (permanent)
          return { activeTabId: permanent.id, mruIds: bumpMru(state.mruIds, permanent.id) }

        const previewIdx = state.tabs.findIndex((t) => t.mode === 'preview')
        const currentPreview = previewIdx === -1 ? null : state.tabs[previewIdx]

        // The current preview already shows this request → just keep it focused.
        if (currentPreview && currentPreview.filePath === filePath) {
          return {
            activeTabId: currentPreview.id,
            mruIds: bumpMru(state.mruIds, currentPreview.id)
          }
        }

        const tab = createTab({ title, filePath, mode: 'preview' })

        // Replace the existing preview in place (same tab-bar position). A fresh
        // tab id is used on purpose so the editor re-parses the newly-shown file
        // (its load cache is keyed by tab id).
        if (currentPreview) {
          cancelReconcile(currentPreview.id)
          const tabs = state.tabs.slice()
          tabs[previewIdx] = tab
          return {
            tabs,
            activeTabId: tab.id,
            mruIds: bumpMru(pruneMru(state.mruIds, new Set(tabs.map((x) => x.id))), tab.id)
          }
        }

        return {
          tabs: [...state.tabs, tab],
          activeTabId: tab.id,
          mruIds: bumpMru(state.mruIds, tab.id)
        }
      }),

    promoteTab: (id) =>
      set((state) => {
        const tab = state.tabs.find((t) => t.id === id)
        if (!tab || tab.mode !== 'preview') return state
        return {
          tabs: state.tabs.map((t) => (t.id === id ? { ...t, mode: 'permanent' } : t))
        }
      }),

    closeTab: (id) =>
      set((state) => {
        const idx = state.tabs.findIndex((t) => t.id === id)
        if (idx === -1) return state
        cancelReconcile(id)
        const remaining = state.tabs.filter((t) => t.id !== id)
        if (remaining.length === 0) {
          // REQ-0084: closing the last tab reaches the empty state — no untitled
          // tab is spawned.
          return { tabs: [], activeTabId: null, mruIds: [] }
        }
        const nextActive =
          state.activeTabId === id
            ? (remaining[Math.min(idx, remaining.length - 1)]?.id ?? null)
            : state.activeTabId
        const mruIds = bumpMru(
          pruneMru(state.mruIds, new Set(remaining.map((t) => t.id))),
          nextActive
        )
        return { tabs: remaining, activeTabId: nextActive, mruIds }
      }),

    closeOtherTabs: (id) =>
      set((state) => {
        const keep = state.tabs.find((t) => t.id === id)
        if (!keep) return state
        // Spare pinned tabs (and the anchor); only the rest close.
        return closeTabSet(state, closeOthersIds(state.tabs, id), id)
      }),

    closeAllTabs: () =>
      set((state) => {
        const ids = closeAllIds(state.tabs)
        if (ids.length === 0) return state
        const closeSet = new Set(ids)
        for (const id of ids) cancelReconcile(id)
        const remaining = state.tabs.filter((t) => !closeSet.has(t.id)) // pinned survivors
        if (remaining.length === 0) return { tabs: [], activeTabId: null, mruIds: [] }
        const stillActive = state.activeTabId !== null && !closeSet.has(state.activeTabId)
        const nextActive = stillActive ? state.activeTabId : remaining[0].id
        const mruIds = bumpMru(
          pruneMru(state.mruIds, new Set(remaining.map((t) => t.id))),
          nextActive
        )
        return { tabs: remaining, activeTabId: nextActive, mruIds }
      }),

    closeTabsToRight: (id) => set((state) => closeTabSet(state, closeRightIds(state.tabs, id), id)),

    closeTabsToLeft: (id) => set((state) => closeTabSet(state, closeLeftIds(state.tabs, id), id)),

    pinTab: (id) => set((state) => ({ tabs: pinTabOrder(state.tabs, id) })),

    unpinTab: (id) => set((state) => ({ tabs: unpinTabOrder(state.tabs, id) })),

    reorderTabs: (fromId, toId) =>
      set((state) => {
        const next = reorderClamped(state.tabs, fromId, toId)
        return next === state.tabs ? state : { tabs: next }
      }),

    repointTabs: (mappings) =>
      set((state) => {
        if (mappings.length === 0) return state
        const byOld = new Map(mappings.map((m) => [m.oldPath, m.newPath]))
        let changed = false
        const tabs = state.tabs.map((t) => {
          if (t.filePath == null) return t
          const newPath = byOld.get(t.filePath)
          if (newPath === undefined) return t
          changed = true
          return {
            ...t,
            filePath: newPath,
            title: basenameOfPath(newPath).replace(/\.http$/, ''),
            removedOnDisk: false,
            conflict: false
          }
        })
        return changed ? { tabs } : state
      }),

    setActiveTab: (id) => set((state) => ({ activeTabId: id, mruIds: bumpMru(state.mruIds, id) })),

    cycleActiveTab: (id) => set({ activeTabId: id }),

    updateTab: (id, changes) => {
      set((state) => ({
        tabs: state.tabs.map((t) => {
          if (t.id !== id) return t
          const next = { ...t, ...changes }
          // REQ-0085: dirtying a tab promotes it out of preview — a dirty tab is
          // never a preview tab. (A pinned tab stays pinned when dirtied.)
          if (changes.isDirty === true && next.mode === 'preview') next.mode = 'permanent'
          return next
        })
      }))
      // REQ-0095: a content change schedules revert-detection. The immediate
      // `isDirty` (passed by the caller on an edit) stands until then. Load paths
      // pair this with markClean(), which cancels the scheduled reconcile.
      if (changes.request !== undefined) scheduleReconcile(id)
    },

    updateRequest: (id, request) => {
      set((state) => ({
        tabs: state.tabs.map((t) =>
          // REQ-0085: editing always dirties, which promotes a preview tab (a
          // pinned tab stays pinned).
          t.id === id
            ? {
                ...t,
                request: { ...t.request, ...request },
                isDirty: true,
                mode: t.mode === 'preview' ? 'permanent' : t.mode
              }
            : t
        )
      }))
      scheduleReconcile(id)
    },

    markClean: (id, baselineHash) => {
      cancelReconcile(id)
      set((state) => ({
        tabs: state.tabs.map((t) => {
          if (t.id !== id) return t
          // Pin to the written content when provided (save), else the current
          // content (load). Then derive modified the same way every other path
          // does: diverged-from-baseline OR malformed.
          const next = { ...t, cleanHash: baselineHash ?? cleanHashOf(t) }
          const dirty = computeTabDirty(next)
          return {
            ...next,
            isDirty: dirty,
            mode: dirty && next.mode === 'preview' ? 'permanent' : next.mode
          }
        })
      }))
    },

    restoreSession: (tabs, activeIndex) => {
      cancelReconcilesExcept(new Set())
      set(() => {
        // Enforce the single-preview invariant on restore: honour only the first
        // persisted preview, regardless of what the file claims (the rest become
        // permanent). Pinned tabs are restored as-is. The modes are exclusive, so
        // there is nothing to reconcile between them.
        let previewSeen = false
        const restored = tabs.map((t) => {
          let mode: TabMode = t.mode ?? 'permanent'
          if (mode === 'preview') {
            if (previewSeen) mode = 'permanent'
            else previewSeen = true
          }
          return createTab({
            filePath: t.path,
            title: basenameOfPath(t.path).replace(/\.http$/, ''),
            mode
          })
        })
        const activeTabId =
          activeIndex >= 0 && activeIndex < restored.length ? restored[activeIndex].id : null
        // Pinned tabs restore grouped at the front (idempotent when the persisted
        // order was already grouped). Seed the MRU with the active tab first.
        const grouped = regroup(restored)
        const order = grouped.map((t) => t.id)
        const mruIds = activeTabId ? bumpMru(order, activeTabId) : order
        return { tabs: grouped, activeTabId, mruIds }
      })
    }
  }
})
