/**
 * Pure most-recently-used (MRU) tab cycling — the "Ctrl+Tab without an overlay"
 * model. The stateful glue (tracking the Ctrl key being held to anchor a cycle)
 * lives in the keyboard hook; the index math is here so it is unit-testable.
 */

/** Move `id` to the front of an MRU list (most-recent first), de-duplicated. */
export function bumpMru(mru: string[], id: string | null | undefined): string[] {
  if (!id) return mru
  return [id, ...mru.filter((x) => x !== id)]
}

/** Drop every id not present in `keep` (e.g. after tabs are closed). */
export function pruneMru(mru: string[], keep: Set<string>): string[] {
  return mru.filter((id) => keep.has(id))
}

/**
 * Resolve the tab to activate `steps` positions into an MRU cycle anchored on a
 * frozen `snapshot` (index 0 = the tab active when the cycle began). A positive
 * `steps` walks toward **older** tabs (Ctrl+Tab); negative walks back toward more
 * recent ones (Ctrl+Shift+Tab). Both wrap. Returns `null` for an empty snapshot.
 */
export function mruCycle(snapshot: string[], steps: number): string | null {
  const n = snapshot.length
  if (n === 0) return null
  const idx = ((steps % n) + n) % n
  return snapshot[idx]
}
