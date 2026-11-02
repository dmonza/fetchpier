import type { WorkspaceTree } from '../../shared/types'

// Name-conflict *verdicts* live in the core and reach the UI over IPC
// (REQ case-insensitive tree name uniqueness — see `hooks/useNameAvailability`).
// This module keeps only tree navigation and the duplicate pre-fill suggestion.

/** Find a node anywhere in the tree by absolute path. */
export function findNode(nodes: WorkspaceTree[], path: string): WorkspaceTree | null {
  for (const node of nodes) {
    if (node.path === path) return node
    if (node.children) {
      const found = findNode(node.children, path)
      if (found) return found
    }
  }
  return null
}

/** The array (a node's own level) that directly contains `node`, or `[]`. */
export function siblingsOf(tree: WorkspaceTree[], node: WorkspaceTree): WorkspaceTree[] {
  const find = (nodes: WorkspaceTree[]): WorkspaceTree[] | null => {
    if (nodes.some((n) => n.path === node.path)) return nodes
    for (const n of nodes) {
      if (n.children) {
        const found = find(n.children)
        if (found) return found
      }
    }
    return null
  }
  return find(tree) ?? []
}

/**
 * The first free `<base>-copy` name given the names already `taken`, then
 * `<base>-copy-2`, `-copy-3`, … — the same ladder `duplicateEntry` walks on disk,
 * used here to pre-fill the duplicate-instance input with a name that commits
 * cleanly instead of colliding with an existing copy. A suggestion, not a
 * verdict: a collision the pre-fill misses is still caught by the core.
 */
export function firstFreeCopyName(base: string, taken: ReadonlySet<string>): string {
  const first = `${base}-copy`
  if (!taken.has(first)) return first
  let n = 2
  while (taken.has(`${base}-copy-${n}`)) n++
  return `${base}-copy-${n}`
}
