/**
 * Whether a blur from the tree's inline rename/create input should be ignored
 * instead of resolving the edit.
 *
 * Right-clicking the input opens the global text context menu, which takes focus
 * as soon as the pointer moves onto an item (Radix roving focus). That blur must
 * NOT resolve the rename — focus returns to the input when the menu closes. True
 * when the focus target sits inside a popup menu (`role="menu"`).
 */
export function blurLandsInPopupMenu(related: EventTarget | null): boolean {
  return related instanceof HTMLElement && related.closest('[role="menu"]') !== null
}

export type RenameBlurAction = 'ignore' | 'commit' | 'cancel'

/**
 * What the tree's inline rename/create input should do when it loses focus.
 * VSCode-style: clicking away **commits** the edit. Exceptions:
 * - `ignore` when focus moved into a popup menu (the text context menu) — the
 *   edit must survive; focus returns to the input when the menu closes.
 * - `cancel` when the pending name is blank or collides with a sibling — it
 *   cannot be committed, so the edit is discarded.
 */
export function resolveRenameBlur(opts: {
  relatedTarget: EventTarget | null
  isEmpty: boolean
  hasConflict: boolean
}): RenameBlurAction {
  if (blurLandsInPopupMenu(opts.relatedTarget)) return 'ignore'
  if (opts.isEmpty || opts.hasConflict) return 'cancel'
  return 'commit'
}
