/**
 * Pure helpers for the collection-tree drag & drop plus the tree's indent
 * metrics. Kept free of React/DOM so the drop rules are unit-testable.
 */

/** Horizontal indentation per tree level. */
export const TREE_INDENT_PX = 16

/** Base left padding of every row (depth 0). */
const TREE_ROW_BASE_PX = 4

/** Chevron column width (h-3.5 / w-3.5 → 14 px); guides center under it. */
const CHEVRON_PX = 14

export function rowPaddingLeftPx(depth: number): number {
  return depth * TREE_INDENT_PX + TREE_ROW_BASE_PX
}

/**
 * X offset of the vertical indent guide drawn inside the children container of
 * a folder at `depth`: the horizontal center of that folder's chevron.
 */
export function guideLeftPx(depth: number): number {
  return depth * TREE_INDENT_PX + TREE_ROW_BASE_PX + CHEVRON_PX / 2
}

// ── Drop classification ──────────────────────────────────────────────────────

export type DropVerdict = 'move' | 'noop' | 'invalid'

/** Normalize separators and strip any trailing slash so prefix checks hold. */
function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

function parentDirOf(p: string): string {
  const norm = normalize(p)
  const idx = norm.lastIndexOf('/')
  return idx === -1 ? '' : norm.slice(0, idx)
}

/**
 * Decide what dropping `sourcePath` onto `targetFolder` means:
 * - `invalid` — no source (foreign drag), or the target is the source itself
 *   or one of its descendants (a folder cannot be moved into itself).
 * - `noop` — the source already lives directly inside the target.
 * - `move` — a real move.
 *
 * Callers must not call `preventDefault()` on `dragover` for `invalid`/`noop`
 * so the browser shows the no-drop cursor and never fires `drop`.
 */
export function classifyDrop(sourcePath: string | null, targetFolder: string): DropVerdict {
  if (!sourcePath) return 'invalid'
  const source = normalize(sourcePath)
  const target = normalize(targetFolder)
  if (!source || !target) return 'invalid'
  if (target === source || target.startsWith(`${source}/`)) return 'invalid'
  if (parentDirOf(source) === target) return 'noop'
  return 'move'
}

// ── Drag-source tracking ─────────────────────────────────────────────────────
//
// `dataTransfer.getData()` is unreadable during `dragover` (DnD protected
// mode), so the dragged path is mirrored here between dragstart and dragend.
// Only one drag can be active at a time, so module state is sufficient.

let dragSource: string | null = null

export function setDragSource(path: string): void {
  dragSource = path
}

export function getDragSource(): string | null {
  return dragSource
}

export function clearDragSource(): void {
  dragSource = null
}
