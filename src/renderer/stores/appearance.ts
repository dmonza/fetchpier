import { create } from 'zustand'
import {
  DEFAULT_APPEARANCE,
  DEFAULT_WORKSPACE_APPEARANCE,
  sameAppearance,
  type PaletteLevel
} from '../../shared/palette/preferences'
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
 * The appearance (colour palette) state of this window — requirements *Dynamic
 * color themes* §6.5 and *Workspace color palettes* §6.
 *
 * - `prefs` (the user's), `workspace` (the open workspace's, `inherit` allowed;
 *   `null` with none) and `palettes` (the **effective** maps): what is in force.
 *   Main is the source of truth; the launch data seeds `palettes` so the first
 *   render agrees with the preload.
 * - `drafts`: live palettes shown while editing, before anything is written.
 * - `displayOverride`: a palette shown in place of the effective one for one
 *   mode — Settings → Appearance shows the user's palette for a mode the
 *   workspace overrides. Unlike a draft, it survives saves.
 * - Every change is saved as it is made, at the level (`scope`) being edited:
 *   drags on release, keyboard changes `COMMIT_DELAY_MS` after the last key or
 *   at once on flush.
 * - `snapshot`: how the edited level was when its dialog opened (one at a time —
 *   both dialogs are modal); *Revert changes* returns to it, the mode included
 *   only for the user level.
 *
 * Engine-free: the Appearance panel computes palettes and hands them in.
 */
export const COMMIT_DELAY_MS = 500

export type AppearanceScope = PaletteLevel

type Drafts = Partial<Record<PaletteMode, PaletteTokens | null>>

interface Snapshot {
  scope: AppearanceScope
  prefs: AppearancePalettes
  theme: Theme
}

interface AppearanceStore {
  prefs: AppearancePalettes
  workspace: AppearancePalettes | null
  palettes: ModePalettes
  drafts: Drafts
  displayOverride: { mode: PaletteMode; tokens: PaletteTokens | null } | null
  snapshot: Snapshot | null
  dragging: { mode: PaletteMode; scope: AppearanceScope; startPrefs: AppearancePalettes } | null
  saveError: boolean
  /** The preferences whose save failed, and their level, for Retry. */
  failed: { prefs: AppearancePalettes; scope: AppearanceScope } | null

  reset: () => void
  load: () => Promise<void>
  applyExternal: (state: AppearanceState) => void
  preview: (mode: PaletteMode, tokens: PaletteTokens | null) => void
  setDisplayOverride: (override: { mode: PaletteMode; tokens: PaletteTokens | null } | null) => void
  commit: (prefs: AppearancePalettes, scope?: AppearanceScope) => Promise<void>
  scheduleCommit: (prefs: AppearancePalettes, scope?: AppearanceScope) => void
  flush: () => Promise<void>
  retry: () => Promise<void>
  beginDrag: (mode: PaletteMode, scope?: AppearanceScope) => void
  endDrag: (prefs: AppearancePalettes, scope?: AppearanceScope) => Promise<void>
  /** Drop the drag in progress; returns the preferences it started from. */
  cancelDrag: () => AppearancePalettes
  beginSession: (theme: Theme, scope?: AppearanceScope) => void
  endSession: () => Promise<void>
  canRevert: (theme: Theme) => boolean
  revert: () => Promise<void>
}

let pendingTimer: ReturnType<typeof setTimeout> | null = null
let pending: { prefs: AppearancePalettes; scope: AppearanceScope } | null = null
/** Only the latest save's outcome is adopted, so out-of-order replies cannot regress the state. */
let saveSeq = 0

function clearPending(): void {
  if (pendingTimer) clearTimeout(pendingTimer)
  pendingTimer = null
  pending = null
}

function launchPalettes(): ModePalettes {
  const initial = typeof window !== 'undefined' ? window.api?.appearance?.initial : undefined
  return { light: initial?.light ?? null, dark: initial?.dark ?? null }
}

function initialState(): Pick<
  AppearanceStore,
  | 'prefs'
  | 'workspace'
  | 'palettes'
  | 'drafts'
  | 'displayOverride'
  | 'snapshot'
  | 'dragging'
  | 'saveError'
  | 'failed'
> {
  return {
    prefs: DEFAULT_APPEARANCE,
    workspace: null,
    palettes: launchPalettes(),
    drafts: {},
    displayOverride: null,
    snapshot: null,
    dragging: null,
    saveError: false,
    failed: null
  }
}

/** The preferences being edited at `scope`. */
function levelOf(
  s: Pick<AppearanceStore, 'prefs' | 'workspace'>,
  scope: AppearanceScope
): AppearancePalettes {
  return scope === 'workspace' ? (s.workspace ?? DEFAULT_WORKSPACE_APPEARANCE) : s.prefs
}

const fieldFor = (scope: AppearanceScope, prefs: AppearancePalettes): Partial<AppearanceStore> =>
  scope === 'workspace' ? { workspace: prefs } : { prefs }

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
      if (!get().dragging && !pending) {
        set({ prefs: state.prefs, workspace: state.workspace ?? null, palettes: state.palettes })
      }
    } catch {
      // The launch palettes stay in force; nothing to show the user here.
    }
  },

  applyExternal: (state) => {
    const busy = get().dragging !== null || pending !== null
    // While the user is mid-change, keep their values — only what is in force moves.
    set(
      busy
        ? { palettes: state.palettes }
        : { prefs: state.prefs, workspace: state.workspace ?? null, palettes: state.palettes }
    )
  },

  preview: (mode, tokens) => set((s) => ({ drafts: { ...s.drafts, [mode]: tokens } })),

  setDisplayOverride: (displayOverride) => set({ displayOverride }),

  commit: async (prefs, scope = 'user') => {
    clearPending()
    const seq = ++saveSeq
    set(fieldFor(scope, prefs))
    try {
      const state =
        scope === 'workspace'
          ? await window.api.appearance.setWorkspace(prefs)
          : await window.api.appearance.set(prefs)
      if (seq !== saveSeq) return
      const dragging = get().dragging
      set((s) => ({
        prefs: state.prefs,
        workspace: state.workspace ?? null,
        palettes: state.palettes,
        drafts: dragging ? { [dragging.mode]: s.drafts[dragging.mode] } : {},
        saveError: false,
        failed: null
      }))
    } catch {
      if (seq !== saveSeq) return
      // The palette stays applied for the session (the draft is kept); the
      // failure is surfaced with a retry, never only logged.
      set({ saveError: true, failed: { prefs, scope } })
    }
  },

  scheduleCommit: (prefs, scope = 'user') => {
    if (pendingTimer) clearTimeout(pendingTimer)
    pending = { prefs, scope }
    set(fieldFor(scope, prefs))
    pendingTimer = setTimeout(() => {
      const next = pending
      pendingTimer = null
      pending = null
      if (next) void get().commit(next.prefs, next.scope)
    }, COMMIT_DELAY_MS)
  },

  flush: async () => {
    const next = pending
    if (!next) return
    clearPending()
    await get().commit(next.prefs, next.scope)
  },

  retry: async () => {
    const failed = get().failed
    if (failed) await get().commit(failed.prefs, failed.scope)
  },

  beginDrag: (mode, scope = 'user') =>
    set((s) => ({ dragging: { mode, scope, startPrefs: levelOf(s, scope) } })),

  endDrag: async (prefs, scope = 'user') => {
    set({ dragging: null })
    await get().commit(prefs, scope)
  },

  cancelDrag: () => {
    const drag = get().dragging
    if (!drag) return get().prefs
    set((s) => {
      const drafts = { ...s.drafts }
      delete drafts[drag.mode]
      return { dragging: null, drafts, ...fieldFor(drag.scope, drag.startPrefs) }
    })
    return drag.startPrefs
  },

  beginSession: (theme, scope = 'user') =>
    set((s) => ({ snapshot: { scope, prefs: levelOf(s, scope), theme } })),

  endSession: async () => {
    await get().flush()
    set({ snapshot: null })
  },

  canRevert: (theme) => {
    const snap = get().snapshot
    if (!snap) return false
    const changed = !sameAppearance(levelOf(get(), snap.scope), snap.prefs, snap.scope)
    return snap.scope === 'user' ? changed || theme !== snap.theme : changed
  },

  revert: async () => {
    const snap = get().snapshot
    if (!snap) return
    clearPending()
    if (snap.scope === 'user') {
      const themeStore = useThemeStore.getState()
      if (themeStore.theme !== snap.theme) themeStore.setTheme(snap.theme)
    }
    set({ drafts: {}, dragging: null })
    await get().commit(snap.prefs, snap.scope)
  }
}))
