import { join } from 'node:path'
import { workspace } from '@fetchpier/core'

const TREE_STATE_FILE_REL = join('requests', '.state', 'tree-state.json')
const DEBOUNCE_MS = 200

/**
 * Per-workspace persistence of the collection-tree expansion state. The on-disk
 * payload is a flat array of **workspace-relative, forward-slash** folder paths
 * that the user has expanded. A folder absent from the array is collapsed.
 *
 * The renderer owns the set (it has the full tree, so it does GC and the
 * first-run "seed everything expanded" decision). This store is a thin,
 * write-through cache mirroring the `ui-state-store` pattern: debounced async
 * write, atomic `.tmp` → rename, and a synchronous flush for `before-quit`.
 */
interface ActiveState {
  workspacePath: string
  expanded: string[]
  /**
   * Whether `tree-state.json` existed on disk when the workspace was loaded.
   * Surfaced to the renderer (via `getAll` returning `null`) so it can tell
   * "first run → seed all folders expanded" apart from "user collapsed
   * everything → respect the empty array".
   */
  fileExisted: boolean
  writeTimer: ReturnType<typeof setTimeout> | null
  pendingWrite: boolean
}

let active: ActiveState | null = null

/** Coerce arbitrary JSON into a deduped array of non-empty `/`-normalized paths. */
function sanitize(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const norm = item.replace(/\\/g, '/').trim()
    if (norm.length === 0 || seen.has(norm)) continue
    seen.add(norm)
    out.push(norm)
  }
  return out
}

/** Returns `null` when the file is absent (ENOENT) or unreadable; array otherwise. */
async function readFromDisk(workspacePath: string): Promise<string[] | null> {
  try {
    const raw = await workspace.openWorkspace(workspacePath).readTextFile(TREE_STATE_FILE_REL)
    return sanitize(JSON.parse(raw) as unknown)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    console.warn(`[tree-state] failed to read ${TREE_STATE_FILE_REL}:`, err)
    return null
  }
}

/**
 * Load the persisted expansion state for a workspace. Calling this with a
 * different `workspacePath` than the currently active one first `flushSync`es
 * and detaches the previous workspace's state.
 */
export async function loadFromWorkspace(workspacePath: string): Promise<void> {
  if (active && active.workspacePath !== workspacePath) {
    flushSync()
    active = null
  }

  const fromDisk = await readFromDisk(workspacePath)
  active = {
    workspacePath,
    expanded: fromDisk ?? [],
    fileExisted: fromDisk !== null,
    writeTimer: null,
    pendingWrite: false
  }
}

/** Flush any pending write synchronously and detach from the workspace. */
export function clearWorkspace(): void {
  flushSync()
  active = null
}

/**
 * The expanded folder paths, or `null` when no workspace is active or the file
 * never existed on disk. `null` tells the renderer to seed (first run); an
 * array — including `[]` — is the user's explicit state.
 */
export function getAll(): string[] | null {
  if (!active) return null
  return active.fileExisted ? [...active.expanded] : null
}

/**
 * Replace the expanded set with `paths` (sanitized) and schedule a debounced
 * write. Once written the file exists, so subsequent `getAll` calls return the
 * array instead of `null`.
 */
export function setExpanded(paths: unknown): string[] {
  if (!active) return []
  const cleaned = sanitize(paths)
  active.expanded = cleaned
  active.fileExisted = true
  scheduleWrite()
  return cleaned
}

function scheduleWrite(): void {
  if (!active) return
  active.pendingWrite = true
  if (active.writeTimer) clearTimeout(active.writeTimer)
  active.writeTimer = setTimeout(() => {
    void flushAsync()
  }, DEBOUNCE_MS)
}

async function flushAsync(): Promise<void> {
  if (!active) return
  const { workspacePath, expanded } = active
  active.writeTimer = null
  active.pendingWrite = false
  try {
    await workspace
      .openWorkspace(workspacePath)
      .atomicWrite(TREE_STATE_FILE_REL, JSON.stringify(expanded, null, 2))
  } catch (err) {
    console.error('[tree-state] failed to flush:', err)
  }
}

/**
 * Synchronously write any pending state to disk. Safe to call from
 * `before-quit` — uses the handle's synchronous atomic write so the OS
 * guarantees the bytes are flushed before the process exits.
 */
export function flushSync(): void {
  if (!active) return
  if (active.writeTimer) {
    clearTimeout(active.writeTimer)
    active.writeTimer = null
  }
  if (!active.pendingWrite) return
  active.pendingWrite = false

  try {
    workspace
      .openWorkspace(active.workspacePath)
      .atomicWriteSync(TREE_STATE_FILE_REL, JSON.stringify(active.expanded, null, 2))
  } catch (err) {
    console.error('[tree-state] failed to flushSync:', err)
  }
}

/** Test-only hook. Resets the in-memory singleton without touching disk. */
export function _resetForTests(): void {
  if (active?.writeTimer) clearTimeout(active.writeTimer)
  active = null
}
