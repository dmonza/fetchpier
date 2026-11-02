/**
 * REQ-0073 §5.2 — the reference mark. For each known (recent) workspace, read
 * its secrets manifest and record which keyId it references, so the Workspace
 * keys tab can show "In use by …" honestly.
 *
 * Honesty rules:
 * - A workspace whose folder is missing/unreadable cannot be checked → it bumps
 *   `incomplete` ("could not check") and contributes no mapping. The app cannot
 *   prove such a workspace does NOT use a key.
 * - A workspace that exists but has no manifest genuinely uses no key → it is
 *   simply absent from the mapping and does not affect `incomplete`.
 *
 * Read fresh on every tab open; never cached.
 */
import { promises as fs } from 'node:fs'
import { basename } from 'node:path'
import { workspace } from '@fetchpier/core'
import type { WorkspaceKeyReferences } from '../../shared/types'

export async function computeReferences(workspacePaths: string[]): Promise<WorkspaceKeyReferences> {
  const byKeyId: Record<string, string[]> = {}
  let incomplete = false

  for (const wsPath of workspacePaths) {
    let isDir: boolean
    try {
      isDir = (await fs.stat(wsPath)).isDirectory()
    } catch {
      isDir = false
    }
    if (!isDir) {
      // Folder deleted/moved/unreadable: we cannot rule out that it uses a key.
      incomplete = true
      continue
    }
    try {
      const manifest = await workspace.openWorkspace(wsPath).secrets.readManifest()
      if (manifest) {
        const keyId = manifest.encryption.keyId
        const name = basename(wsPath)
        ;(byKeyId[keyId] ??= []).push(name)
      }
    } catch {
      // Folder exists but the manifest could not be read (corrupt/permissions).
      incomplete = true
    }
  }

  return { byKeyId, incomplete }
}
