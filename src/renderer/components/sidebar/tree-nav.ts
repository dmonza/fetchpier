/**
 * Pure keyboard-navigation helpers for the collection tree. Kept free of
 * React/DOM (like `tree-dnd.ts`) so the roving-focus rules and type-ahead are
 * exhaustively unit-testable; `CollectionTree` flattens the tree, asks
 * {@link resolveTreeKey} for an intent, and dispatches it to the existing stores
 * and handlers.
 */

import type { WorkspaceTree } from '../../../shared/types'
import { instanceDisplayName } from '../../../shared/lib/request-instances'

/** A node as it appears in the flattened, currently-visible tree. */
export interface VisibleNode {
  path: string
  /** Display label, as rendered (request stem / instance name / folder name). */
  name: string
  type: 'file' | 'folder'
  depth: number
  /** Folder, or a request that has instance children. */
  expandable: boolean
  expanded: boolean
  parentPath: string | null
}

function nodeIsExpandable(node: WorkspaceTree): boolean {
  return node.type === 'folder' || (node.kind === 'request' && (node.children?.length ?? 0) > 0)
}

function displayName(node: WorkspaceTree, parentStem: string | null): string {
  if (node.type === 'folder') return node.name
  if (node.kind === 'instance') {
    return instanceDisplayName(node.name, new Set(parentStem ? [parentStem] : []))
  }
  return node.name.replace(/\.http$/, '')
}

/**
 * Flatten the tree into the ordered list of nodes the user can currently see,
 * honouring each expandable node's open/closed state. The order matches the
 * rendered order exactly, so arrow navigation lines up with what is on screen.
 */
export function flattenVisible(
  nodes: WorkspaceTree[],
  isExpanded: (path: string) => boolean,
  depth = 0,
  parentPath: string | null = null,
  parentStem: string | null = null,
  acc: VisibleNode[] = []
): VisibleNode[] {
  for (const node of nodes) {
    const expandable = nodeIsExpandable(node)
    const expanded = expandable ? isExpanded(node.path) : false
    acc.push({
      path: node.path,
      name: displayName(node, parentStem),
      type: node.type,
      depth,
      expandable,
      expanded,
      parentPath
    })
    if (expandable && expanded && node.children) {
      const stem = node.kind === 'request' ? node.name.replace(/\.http$/, '') : null
      flattenVisible(node.children, isExpanded, depth + 1, node.path, stem, acc)
    }
  }
  return acc
}

/** The action a key press maps to, given the focused node. `null` = no-op. */
export type TreeKeyIntent =
  | { type: 'focus'; path: string }
  | { type: 'setExpanded'; path: string; open: boolean }
  | { type: 'open'; path: string }
  | { type: 'rename'; path: string }
  | { type: 'delete'; path: string }
  | null

/**
 * Map a key press to a navigation/action intent over the flattened visible list.
 * Navigation (arrows / Home / End) only moves focus — it never opens a request.
 * Enter opens a file (or toggles a folder); F2 renames; Delete deletes.
 */
export function resolveTreeKey(
  visible: VisibleNode[],
  focusedPath: string | null,
  key: string
): TreeKeyIntent {
  if (visible.length === 0) return null
  const last = visible.length - 1
  const idx = focusedPath === null ? -1 : visible.findIndex((n) => n.path === focusedPath)

  // No (or stale) focus: the first downward/forward key seeds focus.
  if (idx === -1) {
    if (key === 'ArrowDown' || key === 'Home') return { type: 'focus', path: visible[0].path }
    if (key === 'ArrowUp' || key === 'End') return { type: 'focus', path: visible[last].path }
    return null
  }

  const node = visible[idx]

  switch (key) {
    case 'ArrowDown':
      return idx < last ? { type: 'focus', path: visible[idx + 1].path } : null
    case 'ArrowUp':
      return idx > 0 ? { type: 'focus', path: visible[idx - 1].path } : null
    case 'Home':
      return idx !== 0 ? { type: 'focus', path: visible[0].path } : null
    case 'End':
      return idx !== last ? { type: 'focus', path: visible[last].path } : null
    case 'ArrowRight':
      if (node.expandable && !node.expanded)
        return { type: 'setExpanded', path: node.path, open: true }
      if (node.expandable && node.expanded && idx < last && visible[idx + 1].depth > node.depth) {
        return { type: 'focus', path: visible[idx + 1].path }
      }
      return null
    case 'ArrowLeft':
      if (node.expandable && node.expanded)
        return { type: 'setExpanded', path: node.path, open: false }
      return node.parentPath ? { type: 'focus', path: node.parentPath } : null
    case 'Enter':
      return node.type === 'folder'
        ? { type: 'setExpanded', path: node.path, open: !node.expanded }
        : { type: 'open', path: node.path }
    case 'F2':
      return { type: 'rename', path: node.path }
    case 'Delete':
      return { type: 'delete', path: node.path }
    default:
      return null
  }
}

/**
 * Resolve type-ahead: the path of the next visible node whose display name starts
 * with `prefix` (case-insensitive). A single-character prefix searches **after**
 * the focused node so repeating the key cycles through matches; a longer prefix
 * searches **from** the focused node so the growing prefix sticks to the current
 * match. Wraps around the list. Returns `null` when nothing matches.
 */
export function typeAheadMatch(
  visible: VisibleNode[],
  focusedPath: string | null,
  prefix: string
): string | null {
  if (visible.length === 0 || prefix.length === 0) return null
  const needle = prefix.toLowerCase()
  const focusedIdx = focusedPath === null ? -1 : visible.findIndex((n) => n.path === focusedPath)
  const start = prefix.length === 1 ? focusedIdx + 1 : Math.max(focusedIdx, 0)
  for (let i = 0; i < visible.length; i++) {
    const node = visible[(start + i) % visible.length]
    if (node.name.toLowerCase().startsWith(needle)) return node.path
  }
  return null
}
