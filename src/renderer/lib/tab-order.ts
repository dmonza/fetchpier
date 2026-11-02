/**
 * Pure helpers for tab-bar ordering, pinning, and the bulk-close target sets.
 * Kept free of React/Zustand so the rules are exhaustively unit-testable; the
 * request store calls these and applies the result.
 *
 * Invariant maintained by every function here: **pinned tabs come first**, each
 * group (pinned, unpinned) keeping its relative order. A preview tab is never
 * pinned — pinning one promotes it (the caller clears `isPreview`).
 */

import type { TabMode } from '../../shared/types'

/** Minimal shape the ordering helpers need; `Tab` satisfies it structurally. */
export interface OrderedTab {
  id: string
  mode: TabMode
}

function isPinned(tab: OrderedTab): boolean {
  return tab.mode === 'pinned'
}

/**
 * Stable-partition so every pinned tab precedes every unpinned one, each group
 * preserving its original relative order. Idempotent on an already-grouped list.
 */
export function regroup<T extends OrderedTab>(tabs: T[]): T[] {
  const pinned = tabs.filter(isPinned)
  const unpinned = tabs.filter((t) => !isPinned(t))
  return [...pinned, ...unpinned]
}

/**
 * Pin `id`: set its mode to `'pinned'` (which also promotes a preview, since the
 * modes are exclusive) and move it to the **end of the pinned group** (front of
 * the bar, after any already-pinned tabs). No-op when `id` is absent.
 */
export function pinTab<T extends OrderedTab>(tabs: T[], id: string): T[] {
  if (!tabs.some((t) => t.id === id)) return tabs
  const mapped = tabs.map((t) => (t.id === id ? { ...t, mode: 'pinned' as const } : t))
  return regroup(mapped)
}

/**
 * Unpin `id`: set its mode to `'permanent'` and move it to the **front of the
 * unpinned group** (right after the last remaining pinned tab). No-op when `id`
 * is absent.
 */
export function unpinTab<T extends OrderedTab>(tabs: T[], id: string): T[] {
  if (!tabs.some((t) => t.id === id)) return tabs
  const mapped = tabs.map((t) => (t.id === id ? { ...t, mode: 'permanent' as const } : t))
  return regroup(mapped)
}

/**
 * Move `fromId` to `toId`'s slot, **clamped to the same group**: a pinned tab can
 * only be reordered among pinned tabs and an unpinned among unpinned. A drag that
 * would cross the pinned/unpinned boundary is rejected (returns the list
 * unchanged) — pin state only ever changes through {@link pinTab}/{@link unpinTab}.
 */
export function reorderClamped<T extends OrderedTab>(tabs: T[], fromId: string, toId: string): T[] {
  if (fromId === toId) return tabs
  const from = tabs.find((t) => t.id === fromId)
  const to = tabs.find((t) => t.id === toId)
  if (!from || !to) return tabs
  if (isPinned(from) !== isPinned(to)) return tabs // boundary clamp
  const next = tabs.slice()
  const fromIdx = next.findIndex((t) => t.id === fromId)
  const [moved] = next.splice(fromIdx, 1)
  const toIdx = next.findIndex((t) => t.id === toId)
  next.splice(toIdx, 0, moved)
  return next
}

/** Ids of the tabs positioned strictly **after** `id`, excluding pinned tabs. */
export function closeRightIds(tabs: OrderedTab[], id: string): string[] {
  const idx = tabs.findIndex((t) => t.id === id)
  if (idx === -1) return []
  return tabs
    .slice(idx + 1)
    .filter((t) => !isPinned(t))
    .map((t) => t.id)
}

/** Ids of the tabs positioned strictly **before** `id`, excluding pinned tabs. */
export function closeLeftIds(tabs: OrderedTab[], id: string): string[] {
  const idx = tabs.findIndex((t) => t.id === id)
  if (idx === -1) return []
  return tabs
    .slice(0, idx)
    .filter((t) => !isPinned(t))
    .map((t) => t.id)
}

/** Ids of every tab except `id`, excluding pinned tabs (which are spared). */
export function closeOthersIds(tabs: OrderedTab[], id: string): string[] {
  return tabs.filter((t) => t.id !== id && !isPinned(t)).map((t) => t.id)
}

/** Ids of every tab, excluding pinned tabs (which are spared by "close all"). */
export function closeAllIds(tabs: OrderedTab[]): string[] {
  return tabs.filter((t) => !isPinned(t)).map((t) => t.id)
}

/**
 * The id to activate when paging through the bar in **visual order**. `direction`
 * is `+1` (next / PageDown) or `-1` (previous / PageUp); both wrap. Returns the
 * current id when there are fewer than two tabs, or `null` when `activeId` is
 * absent.
 */
export function nextInOrder(
  tabs: OrderedTab[],
  activeId: string | null,
  direction: 1 | -1
): string | null {
  if (tabs.length === 0) return null
  if (tabs.length === 1) return tabs[0].id
  const idx = tabs.findIndex((t) => t.id === activeId)
  if (idx === -1) return tabs[0].id
  const nextIdx = (idx + direction + tabs.length) % tabs.length
  return tabs[nextIdx].id
}
