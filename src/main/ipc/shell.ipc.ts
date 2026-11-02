import { ipcMain, shell } from 'electron'
import { promises as fs } from 'node:fs'
import { resolve, relative, isAbsolute } from 'node:path'
import { requireActiveWorkspaceHandle } from '../state/active-workspace'

/**
 * OS-shell handlers. The single operation here — revealing a path in the native
 * file manager — is the only privileged shell access the renderer can reach
 * (it must never import `electron`/`shell` itself). Every target is validated to
 * live inside the active workspace before the OS is asked to highlight it.
 */

/**
 * Resolve `absPath` to a filesystem target inside `workspaceRoot`, rejecting any
 * path that escapes the workspace. Pure (no fs / Electron) so the containment
 * rule is unit-testable. Throws `PATH_OUTSIDE_WORKSPACE` for an escaping path.
 */
export function resolveRevealTarget(workspaceRoot: string, absPath: string): string {
  const root = resolve(workspaceRoot)
  const target = resolve(absPath)
  const rel = relative(root, target)
  const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  if (!inside) throw new Error('PATH_OUTSIDE_WORKSPACE')
  return target
}

export function registerShellHandlers(): void {
  ipcMain.handle('shell:revealPath', async (_event, absPath: string): Promise<void> => {
    const root = requireActiveWorkspaceHandle().path
    const target = resolveRevealTarget(root, absPath)
    // Confirm the path still exists (throws ENOENT otherwise) before revealing it.
    await fs.stat(target)
    shell.showItemInFolder(target)
  })
}
