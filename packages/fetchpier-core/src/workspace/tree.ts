import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { WorkspaceTree } from '@shared/types'
import { HTTP_SUFFIX, isInstanceFileName, splitInstanceName } from '@shared/lib/request-instances'

/** User-tree root under the workspace. All `.http` files live here. */
export const REQUESTS_DIR = 'requests'

/** Absolute path of the user-tree root for a given workspace. */
export function requestsRootPath(workspacePath: string): string {
  return join(workspacePath, REQUESTS_DIR)
}

/**
 * Recursively reads the user-tree (`<workspace>/requests/`) and returns a
 * sorted tree of folders and .http files, ignoring hidden entries — including
 * `.runs/` (per-artifact activity log) and any other dotfile.
 *
 * Instance files (`<stem>.<name>.instance.http`) are grouped as
 * `children` of their parent request (`<stem>.http`) when one exists in the
 * same directory; an instance with no sibling parent is rendered as a
 * top-level orphan node of kind `'instance'`.
 */
export async function readTree(dirPath: string): Promise<WorkspaceTree[]> {
  let names: string[]
  try {
    names = await fs.readdir(dirPath)
  } catch {
    return []
  }

  const folders: WorkspaceTree[] = []
  const regulars: WorkspaceTree[] = []
  const instanceNames: string[] = []

  for (const name of names) {
    // Skip hidden files/folders (names starting with '.')
    if (name.startsWith('.')) continue

    const fullPath = join(dirPath, name)

    let stat: Awaited<ReturnType<typeof fs.stat>>
    try {
      stat = await fs.stat(fullPath)
    } catch {
      continue
    }

    if (stat.isDirectory()) {
      const children = await readTree(fullPath)
      folders.push({
        name,
        path: fullPath,
        type: 'folder',
        kind: 'folder',
        children
      })
    } else if (stat.isFile() && name.endsWith(HTTP_SUFFIX)) {
      if (isInstanceFileName(name)) {
        instanceNames.push(name)
      } else {
        regulars.push({
          name,
          path: fullPath,
          type: 'file',
          kind: 'request'
        })
      }
    }
  }

  // Index regular requests by their stem so instances can bind to a parent.
  const stemToParent = new Map<string, WorkspaceTree>()
  for (const node of regulars) {
    stemToParent.set(node.name.slice(0, -HTTP_SUFFIX.length), node)
  }
  const stems = new Set(stemToParent.keys())

  const orphanInstances: WorkspaceTree[] = []
  for (const instName of instanceNames) {
    const node: WorkspaceTree = {
      name: instName,
      path: join(dirPath, instName),
      type: 'file',
      kind: 'instance'
    }
    const split = splitInstanceName(instName, stems)
    const parent = split ? stemToParent.get(split.parentStem) : undefined
    if (parent) {
      ;(parent.children ??= []).push(node)
    } else {
      orphanInstances.push(node)
    }
  }

  // Sort each parent's instance children alphabetically (shared prefix ⇒
  // filename order equals instance-name order).
  for (const node of regulars) {
    node.children?.sort((a, b) => a.name.localeCompare(b.name))
  }

  // Folders first, then files (regular requests + orphan instances)
  // alphabetically — preserving the historical top-level ordering.
  folders.sort((a, b) => a.name.localeCompare(b.name))
  const files = [...regulars, ...orphanInstances].sort((a, b) => a.name.localeCompare(b.name))

  return [...folders, ...files]
}

// Matches `# @id <uuid-or-similar>` on its own line. Loose on UUID shape so any
// stable identifier Fetchpier writes is accepted.
const ID_LINE_REGEX = /^\s*#\s*@id\s+([0-9a-fA-F][0-9a-fA-F-]{7,})\s*$/

/**
 * Read just the leading bytes of a `.http` file to extract its `# @id`. Same
 * region as the parser's reader: the leading comment block, blank lines skipped,
 * up to the first non-blank line that is not a comment (the request line).
 */
async function extractRequestId(filePath: string): Promise<string | null> {
  let fh: Awaited<ReturnType<typeof fs.open>> | null = null
  try {
    fh = await fs.open(filePath, 'r')
    const buf = Buffer.alloc(1024)
    const { bytesRead } = await fh.read(buf, 0, 1024, 0)
    const chunk = buf.subarray(0, bytesRead).toString('utf-8')
    for (const line of chunk.split(/\r?\n|\r/)) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      if (!trimmed.startsWith('#') && !trimmed.startsWith('//')) break
      const match = ID_LINE_REGEX.exec(trimmed)
      if (match) return match[1]
    }
    return null
  } catch {
    return null
  } finally {
    if (fh) await fh.close().catch(() => undefined)
  }
}

/**
 * Collect the `# @id` of every `.http` request under `requests/` (recursively,
 * skipping dot-entries). Used by the UI-state GC to drop state for requests that
 * no longer exist — replacing a tree-walk that the desktop adapter used to
 * duplicate.
 */
export async function collectRequestIds(workspacePath: string): Promise<Set<string>> {
  const ids = new Set<string>()
  async function walk(dir: string): Promise<void> {
    let names: string[]
    try {
      names = await fs.readdir(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (name.startsWith('.')) continue
      const p = join(dir, name)
      let stat: Awaited<ReturnType<typeof fs.stat>>
      try {
        stat = await fs.stat(p)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        await walk(p)
      } else if (stat.isFile() && name.endsWith(HTTP_SUFFIX)) {
        const id = await extractRequestId(p)
        if (id) ids.add(id)
      }
    }
  }
  await walk(requestsRootPath(workspacePath))
  return ids
}
