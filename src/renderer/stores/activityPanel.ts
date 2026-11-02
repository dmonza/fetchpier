import { create } from 'zustand'
import type {
  ActivityPanelPopoutEvent,
  ActivityPanelSettings,
  ActivityTabId
} from '../../shared/types'

const PERSIST_DEBOUNCE_MS = 300
const MIN_HEIGHT_PX = 200
/** Vertical chrome (status bar + tab bar + margin) the panel must never cover. */
const RESERVED_CHROME_PX = 100

interface ActivityPanelState {
  isOpen: boolean
  isDetached: boolean
  heightPx: number | null
  activeTab: ActivityTabId

  /** Initialise from persisted AppSettings.activityPanel (called once on app boot). */
  hydrate: (settings: ActivityPanelSettings | undefined) => void
  toggle: () => void
  open: () => void
  close: () => void
  setActiveTab: (tab: ActivityTabId) => void
  setHeight: (px: number, opts?: { persist?: boolean }) => void
  popout: () => Promise<void>
  requestDock: () => Promise<void>
  applyPopoutEvent: (event: ActivityPanelPopoutEvent) => void
}

let persistTimer: ReturnType<typeof setTimeout> | null = null

function persistHeight(px: number): void {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    void window.api?.appSettings
      ?.set({ activityPanel: { heightPx: px } })
      .catch((err: unknown) => console.error('[activityPanel] persist failed:', err))
  }, PERSIST_DEBOUNCE_MS)
}

export function clampHeight(px: number, windowHeight: number): number {
  const maxHeight = Math.max(MIN_HEIGHT_PX, windowHeight - RESERVED_CHROME_PX)
  const rounded = Math.round(px)
  return Math.max(MIN_HEIGHT_PX, Math.min(maxHeight, rounded))
}

export function computeDefaultHeight(windowHeight: number): number {
  return clampHeight(Math.round(windowHeight * 0.5), windowHeight)
}

export const useActivityPanelStore = create<ActivityPanelState>()((set, get) => ({
  isOpen: false,
  isDetached: false,
  heightPx: null,
  activeTab: 'requests',

  hydrate: (settings) => {
    if (settings?.heightPx && Number.isFinite(settings.heightPx)) {
      set({ heightPx: settings.heightPx })
    }
  },

  toggle: () => {
    const { isDetached, isOpen } = get()
    if (isDetached) {
      void window.api?.activityPanel
        ?.focusPopout()
        .catch((err: unknown) => console.error('[activityPanel] focusPopout failed:', err))
      return
    }
    set({ isOpen: !isOpen })
  },

  open: () => {
    if (get().isDetached) return
    set({ isOpen: true })
  },

  close: () => set({ isOpen: false }),

  setActiveTab: (tab) => set({ activeTab: tab }),

  setHeight: (px, opts) => {
    const windowHeight = typeof window !== 'undefined' ? window.innerHeight : 800
    const next = clampHeight(px, windowHeight)
    set({ heightPx: next })
    if (opts?.persist !== false) {
      persistHeight(next)
    }
  },

  popout: async () => {
    const result = await window.api.activityPanel.popout()
    if (!result.ok) {
      console.error('[activityPanel] popout rejected:', result.reason)
      return
    }
    // The main process will broadcast 'activity-panel:popout-changed'; we
    // optimistically flip state so the docked panel unmounts immediately and
    // the popout doesn't show "behind" it.
    set({ isOpen: false, isDetached: true })
  },

  requestDock: async () => {
    await window.api.activityPanel.dock()
    // The main process will broadcast the docked event; flip state here too so
    // the popout's UI immediately reflects the action.
  },

  applyPopoutEvent: (event) => {
    if (event.detached) {
      set({ isDetached: true, isOpen: false })
    } else {
      set({ isDetached: false, isOpen: !!event.openAfter })
    }
  }
}))
