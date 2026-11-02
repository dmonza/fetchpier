// "Request chips" for the History panel — mirror the currently open editor
// tabs (REQ-0069 follow-up).
//
// Behaviour:
//   - The chip set tracks the open editor tabs that point at saved requests
//     (have a `filePath`, not read-only, not raw). When a tab is opened a
//     chip appears (checked by default); when a tab is closed its chip
//     disappears. The chips list is recomputed via `syncChips` whenever the
//     tab list changes.
//   - The user can uncheck/recheck a chip to include/exclude that request's
//     runs from the History list. Unchecking does NOT remove the chip —
//     only closing the tab does.
//   - When at least one chip is checked, the History list shows only entries
//     whose `requestId` matches a checked chip.
//   - When no chip is checked, the History list shows all entries.
//   - Never persisted. Cleared when the workspace changes.

import { create } from 'zustand'

export interface RequestChip {
  /** Stable request UUID (matches `HistoryEntryListItem.requestId`). */
  requestId: string
  /** Human-friendly label — typically the file basename, optionally prefixed by parent folder. */
  label: string
  /** Whether the chip is currently active as a history filter. */
  checked: boolean
}

export interface HistoryChipsState {
  chips: RequestChip[]
  /**
   * Reconcile chips with the currently open tabs. New tabs add a chip
   * checked-by-default; closed tabs remove their chip; existing chips
   * preserve their `checked` state (and update their label if renamed).
   * The resulting chip order matches `openChips` order (i.e. tab order).
   */
  syncChips: (openChips: Array<{ requestId: string; label: string }>) => void
  /** Flip the checked flag for a single chip. */
  toggleChip: (requestId: string) => void
  /** Reset everything — call when the workspace changes. */
  reset: () => void
}

export const useHistoryChipsStore = create<HistoryChipsState>()((set) => ({
  chips: [],

  syncChips: (openChips) =>
    set((s) => {
      const existingById = new Map(s.chips.map((c) => [c.requestId, c]))
      let mutated = openChips.length !== s.chips.length
      const next: RequestChip[] = openChips.map((o, i) => {
        const existing = existingById.get(o.requestId)
        if (existing) {
          if (existing.label === o.label && s.chips[i] === existing) return existing
          mutated = true
          return existing.label === o.label ? existing : { ...existing, label: o.label }
        }
        mutated = true
        return { requestId: o.requestId, label: o.label, checked: true }
      })
      return mutated ? { chips: next } : {}
    }),

  toggleChip: (requestId) =>
    set((s) => ({
      chips: s.chips.map((c) => (c.requestId === requestId ? { ...c, checked: !c.checked } : c))
    })),

  reset: () => set({ chips: [] })
}))
