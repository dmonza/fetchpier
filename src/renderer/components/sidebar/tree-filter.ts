/**
 * Pure filtering helpers for the collection tree sidebar search. Kept free of
 * React/DOM (like `tree-nav.ts` and `tree-dnd.ts`) so filtering rules are
 * directly unit-testable.
 */

import type { WorkspaceTree } from '../../../shared/types'
import { instanceDisplayName } from '../../../shared/lib/request-instances'

function searchableLabel(node: WorkspaceTree, parentStem: string | null): string {
  if (node.type === 'folder') return node.name
  if (node.kind === 'instance') {
    return instanceDisplayName(node.name, new Set(parentStem ? [parentStem] : []))
  }
  return node.name.replace(/\.http$/, '')
}

/**
 * Filter a collection tree by case-insensitive substring match on each node's
 * display label.
 *
 * - An empty/whitespace query returns `nodes` unchanged.
 * - A folder or parent request whose own label matches keeps all of its
 *   children so the user can still browse inside a matched collection.
 * - Otherwise, a parent is kept only if at least one descendant matches,
 *   pruned to the matching branches.
 */
export function filterTree(
  nodes: WorkspaceTree[],
  query: string,
  parentStem: string | null = null
): WorkspaceTree[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return nodes

  const result: WorkspaceTree[] = []
  for (const node of nodes) {
    const label = searchableLabel(node, parentStem).toLowerCase()
    if (label.includes(needle)) {
      result.push(node)
      continue
    }

    if (node.children && node.children.length > 0) {
      const nextParentStem = node.kind === 'request' ? node.name.replace(/\.http$/, '') : null
      const filteredChildren = filterTree(node.children, needle, nextParentStem)
      if (filteredChildren.length > 0) {
        result.push({ ...node, children: filteredChildren })
      }
    }
  }
  return result
}
