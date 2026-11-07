import { create } from 'zustand'
import { DEFAULT_APPEARANCE, sameAppearance } from '../../shared/palette/preferences'
import type {
  AppearancePalettes,
  AppearanceState,
  ModePalettes,
  PaletteMode,
  PaletteTokens,
  Theme
} from '../../shared/types'
import { useThemeStore } from './theme'

/**
 * The appearance (colour palette) state of this window — requirement *Dynamic
 * color themes* §6.5.
 *
 * - `prefs` / `palettes`: what is in force. Main is the source of truth; the
 *   launch data seeds them so the first render already agrees with the preload.
 * - `drafts`: live palettes shown while the user is editing, before anything is
 *   written (a drag, a pending keyboard change, a failed save).
 * - Every change is saved as it is made, except during a drag (saved on release)
 *   and keyboard changes (saved `COMMIT_DELAY_MS` after the last key, or at once
 *   on flush). Nothing is ever pending once Settings closes.
 * - `snapshot`: how the appearance was when Settings opened; *Revert changes*
 *   returns to it, mode included.
 *
 * Engine-free: the Appearance panel computes draft palettes and hands them in,
 * so the generator stays out of the eager bundle.
 */
export const COMMIT_DELAY_MS = 500

type Drafts = Partial<Record<PaletteMode, PaletteTokens | null>>

interface AppearanceStore {
  prefs: AppearancePalettes
  palettes: ModePalettes
  drafts: Drafts
  snapshot: { prefs: AppearancePalettes; theme: Theme } | null
  dragging: { mode: PaletteMode; startPrefs: AppearancePalettes } | null
  saveError: boolean
  /** The preferences whose save failed, for Retry. */
  failed: AppearancePalettes | null

  reset: () => void
  load: () => Promise<void>
  applyExternal: (state: AppearanceState) => void
  preview: (mode: PaletteMode, tokens: PaletteTokens | null) => void
  commit: (prefs: AppearancePalettes) => Promise<void>
  scheduleCommit: (prefs: AppearancePalettes) => void
  flush: () => Promise<void>
  retry: () => Promise<void>
  beginDrag: (mode: PaletteMode) => void
  endDrag: (prefs: AppearancePalettes) => Promise<void>
  /** Drop the drag in progress; returns the preferences it started from. */
  cancelDrag: () => AppearancePalettes
  beginSession: (theme: Theme) => void
  endSession: () => Promise<void>
  canRevert: (theme: Theme) => boolean
  revert: () => Promise<void>
}

let pendingTimer: ReturnType<typeof setTimeout> | null = null
let pendingPrefs: AppearancePalettes | null = null
/** Only the latest save's outcome is adopted, so out-of-order replies cannot regress the state. */
let saveSeq = 0

function clearPending(): void {
  if (pendingTimer) clearTimeout(pendingTimer)
  pendingTimer = null
  pendingPrefs = null
}

function launchPalettes(): ModePalettes {
  const initial = typeof window !== 'undefined' ? window.api?.appearance?.initial : undefined
  return { light: initial?.light ?? null, dark: initial?.dark ?? null }
}

function initialState(): Pick<
  AppearanceStore,
  'prefs' | 'palettes' | 'drafts' | 'snapshot' | 'dragging' | 'saveError' | 'failed'
> {
  return {
    prefs: DEFAULT_APPEARANCE,
    palettes: launchPalettes(),
    drafts: {},
    snapshot: null,
    dragging: null,
    saveError: false,
    failed: null
  }
}

export const useAppearanceStore = create<AppearanceStore>()((set, get) => ({
  ...initialState(),

  reset: () => {
    clearPending()
    saveSeq++
    set(initialState())
  },

  load: async () => {
    try {
      const state = await window.api.appearance.get()
      if (!get().dragging && !pendingPrefs) set({ prefs: state.prefs, palettes: state.palettes })
    } catch {
      // The launch palettes stay in force; nothing to show the user here.
    }
  },

  applyExternal: (state) => {
    const busy = get().dragging !== null || pendingPrefs !== null
    // While the user is mid-change, keep their values — only what is in force moves.
    set(busy ? { palettes: state.palettes } : { prefs: state.prefs, palettes: state.palettes })
  },

  preview: (mode, tokens) => set((s) => ({ drafts: { ...s.drafts, [mode]: tokens } })),

  commit: async (prefs) => {
    clearPending()
    const seq = ++saveSeq
    set({ prefs })
    try {
      const state = await window.api.appearance.set(prefs)
      if (seq !== saveSeq) return
      const dragging = get().dragging
      set((s) => ({
        prefs: state.prefs,
        palettes: state.palettes,
        drafts: dragging ? { [dragging.mode]: s.drafts[dragging.mode] } : {},
        saveError: false,
        failed: null
      }))
    } catch {
      if (seq !== saveSeq) return
      // The palette stays applied for the session (the draft is kept); the
      // failure is surfaced with a retry, never only logged.
      set({ saveError: true, failed: prefs })
    }
  },

  scheduleCommit: (prefs) => {
    if (pendingTimer) clearTimeout(pendingTimer)
    pendingPrefs = prefs
    set({ prefs })
    pendingTimer = setTimeout(() => {
      const next = pendingPrefs
      pendingTimer = null
      pendingPrefs = null
      if (next) void get().commit(next)
    }, COMMIT_DELAY_MS)
  },

  flush: async () => {
    const next = pendingPrefs
    if (!next) return
    clearPending()
    await get().commit(next)
  },

  retry: async () => {
    const failed = get().failed
    if (failed) await get().commit(failed)
  },

  beginDrag: (mode) => set({ dragging: { mode, startPrefs: get().prefs } }),

  endDrag: async (prefs) => {
    set({ dragging: null })
    await get().commit(prefs)
  },

  cancelDrag: () => {
    const drag = get().dragging
    if (!drag) return get().prefs
    set((s) => {
      const drafts = { ...s.drafts }
      delete drafts[drag.mode]
      return { dragging: null, drafts, prefs: drag.startPrefs }
    })
    return drag.startPrefs
  },

  beginSession: (theme) => set({ snapshot: { prefs: get().prefs, theme } }),

  endSession: async () => {
    await get().flush()
    set({ snapshot: null })
  },

  canRevert: (theme) => {
    const snap = get().snapshot
    if (!snap) return false
    return theme !== snap.theme || !sameAppearance(get().prefs, snap.prefs)
  },

  revert: async () => {
    const snap = get().snapshot
    if (!snap) return
    clearPending()
    const themeStore = useThemeStore.getState()
    if (themeStore.theme !== snap.theme) themeStore.setTheme(snap.theme)
    set({ drafts: {}, dragging: null })
    await get().commit(snap.prefs)
  }
}))
