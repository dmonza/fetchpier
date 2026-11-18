import type { WorkspaceTree } from '../../../shared/types'

/** One folder of the request tree, as a destination picker lists it. */
export interface FolderOption {
  path: string
  label: string
  /** Nesting level below the request-tree root (top-level folders are 0). */
  depth: number
}

/**
 * Flatten every folder of `nodes`, depth-first in tree order, for a destination
 * picker ("Move to…", the import dialog's destination). Files are skipped, and so
 * are `excludePath` and everything under it. The root option is the caller's: each
 * picker labels it differently.
 */
export function collectFolderOptions(
  nodes: WorkspaceTree[],
  excludePath?: string,
  depth = 0
): FolderOption[] {
  const result: FolderOption[] = []
  for (const node of nodes) {
    if (node.type !== 'folder' || node.path === excludePath) continue
    result.push({ path: node.path, label: node.name, depth })
    if (node.children) result.push(...collectFolderOptions(node.children, excludePath, depth + 1))
  }
  return result
}
