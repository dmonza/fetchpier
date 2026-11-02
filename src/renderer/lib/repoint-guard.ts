/**
 * Short-lived guard for in-app rename/move (REQ open-tab-file-reconciliation).
 *
 * When the app itself moves a file, it re-points the affected tabs synchronously,
 * but the file watcher's whole-tree broadcast is asynchronous and can interleave
 * with the in-app handler's remaining awaits (history relinking). During that
 * window the tree no longer holds the *old* path, which would make open-tab
 * removed-detection briefly flag the tab as removed-on-disk before the re-point
 * clears it. Registering the old paths here lets removed-detection skip them, so
 * a self-initiated move is never mistaken for an external removal — not even for
 * a single frame.
 */
const repointing = new Set<string>()

/** Mark `paths` as being re-pointed by an in-app operation in progress. */
export function beginRepoint(paths: string[]): void {
  for (const p of paths) repointing.add(p)
}

/** Clear `paths` once the in-app operation (re-point + relinking) has settled. */
export function endRepoint(paths: string[]): void {
  for (const p of paths) repointing.delete(p)
}

/** True while `path` is mid-flight in an in-app rename/move. */
export function isRepointing(path: string): boolean {
  return repointing.has(path)
}
