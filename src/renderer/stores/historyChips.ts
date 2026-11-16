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
  /**
   * Workspace-relative path of the request's file, set only when the file has
   * no `# @id` (ISS-0081): its runs each recorded a session-random id, so the
   * chip also matches runs by `@source-file` (rule: `@shared/lib/history-filter`).
   */
  sourceFile?: string
}

/** What a tab contributes to the chip set (`syncChips` input). */
export interface OpenRequestChip {
  requestId: string
  label: string
  sourceFile?: string
}

export interface HistoryChipsState {
  chips: RequestChip[]
  /**
   * Reconcile chips with the currently open tabs. New tabs add a chip
   * checked-by-default; closed tabs remove their chip; existing chips
   * preserve their `checked` state (and update their label and source file if
   * renamed). The resulting chip order matches `openChips` order (i.e. tab order);
   * tabs sharing a request id get one chip (the first one's).
   */
  syncChips: (openChips: OpenRequestChip[]) => void
  /** Flip the checked flag for a single chip. */
  toggleChip: (requestId: string) => void
  /** Reset everything — call when the workspace changes. */
  reset: () => void
}

export const useHistoryChipsStore = create<HistoryChipsState>()((set) => ({
  chips: [],

  syncChips: (allOpenChips) =>
    set((s) => {
      // One chip per request id (the first tab wins): two open files can share an
      // `# @id` (a copy made outside the app). Without this the reconcile was not
      // idempotent and a caller syncing on `chips` looped.
      const seen = new Set<string>()
      const openChips = allOpenChips.filter((o) => !seen.has(o.requestId) && seen.add(o.requestId))
      const existingById = new Map(s.chips.map((c) => [c.requestId, c]))
      let mutated = openChips.length !== s.chips.length
      const next: RequestChip[] = openChips.map((o, i) => {
        const existing = existingById.get(o.requestId)
        if (existing) {
          const same = existing.label === o.label && existing.sourceFile === o.sourceFile
          if (same && s.chips[i] === existing) return existing
          mutated = true
          if (same) return existing
          const updated: RequestChip = {
            requestId: existing.requestId,
            label: o.label,
            checked: existing.checked
          }
          if (o.sourceFile !== undefined) updated.sourceFile = o.sourceFile
          return updated
        }
        mutated = true
        const chip: RequestChip = { requestId: o.requestId, label: o.label, checked: true }
        if (o.sourceFile !== undefined) chip.sourceFile = o.sourceFile
        return chip
      })
      return mutated ? { chips: next } : {}
    }),

  toggleChip: (requestId) =>
    set((s) => ({
      chips: s.chips.map((c) => (c.requestId === requestId ? { ...c, checked: !c.checked } : c))
    })),

  reset: () => set({ chips: [] })
}))
