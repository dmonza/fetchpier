/**
 * Machine-local record of opened workspaces (`<userData>/last-workspace.json`):
 * the last-opened pointer plus a small MRU list. Owned here so both the
 * workspace IPC (open/recent menus) and the secrets service (REQ-0073 reference
 * mark) read one source of truth without importing each other.
 */
import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { workspace } from '@fetchpier/core'

export const MAX_RECENT = 5

/** Resolved lazily — `app.getPath` must not run at module load (test mocks). */
function lastWorkspaceFile(): string {
  return join(app.getPath('userData'), 'last-workspace.json')
}

export interface WorkspaceStore {
  path: string
  recent: string[]
}

export async function readWorkspaceStore(): Promise<WorkspaceStore> {
  try {
    const raw = await fs.readFile(lastWorkspaceFile(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<WorkspaceStore>
    return { path: parsed.path ?? '', recent: parsed.recent ?? [] }
  } catch {
    return { path: '', recent: [] }
  }
}

export async function writeWorkspaceStore(store: WorkspaceStore): Promise<void> {
  await workspace.atomicWriteFile(lastWorkspaceFile(), JSON.stringify(store, null, 2))
}

/**
 * Every recent workspace path, unfiltered. Callers that need only existing
 * folders filter themselves; the reference computation deliberately keeps
 * missing folders so it can report "could not check" (REQ-0073 §5.2).
 */
export async function getRecentWorkspacePaths(): Promise<string[]> {
  const store = await readWorkspaceStore()
  return store.recent
}
