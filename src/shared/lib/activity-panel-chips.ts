import type { ActivityPanelChip } from '../types'
import { MAX_ENTRY_ID_LENGTH, isRelativeSourcePath, isText } from './activity-panel-row-action'

/**
 * Validation of the request chip set the main window mirrors to the Activity
 * popout (ISS-0073). Main runs `parseActivityPanelChips` on every
 * `activityPanel:publishChips` payload and `parseChipRequestId` on every
 * `activityPanel:toggleChipInOwner` id before forwarding them. Shape only:
 * nothing here touches disk — `sourceFile` is only ever a filter value the
 * popout passes back to `history:list`, which validates its filter itself.
 */

/** Most chips accepted in one set (one per open saved request). */
export const MAX_MIRRORED_CHIPS = 1000
/** Longest chip label accepted (labels are `folder/name`). */
export const MAX_CHIP_LABEL_LENGTH = 1024

export function parseChipRequestId(value: unknown): string | null {
  return isText(value, MAX_ENTRY_ID_LENGTH) ? value : null
}

/**
 * A fresh copy of a valid chip set holding only each chip's own fields, or
 * `null` when anything is off (including two chips with one id, which the
 * owner never sends).
 */
export function parseActivityPanelChips(value: unknown): ActivityPanelChip[] | null {
  if (!Array.isArray(value) || value.length > MAX_MIRRORED_CHIPS) return null
  const seen = new Set<string>()
  const chips: ActivityPanelChip[] = []
  for (const item of value as unknown[]) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const c = item as Record<string, unknown>
    const requestId = parseChipRequestId(c.requestId)
    if (requestId === null || seen.has(requestId)) return null
    if (!isText(c.label, MAX_CHIP_LABEL_LENGTH) || typeof c.checked !== 'boolean') return null
    const chip: ActivityPanelChip = { requestId, label: c.label, checked: c.checked }
    if (c.sourceFile !== undefined) {
      if (!isRelativeSourcePath(c.sourceFile)) return null
      chip.sourceFile = c.sourceFile
    }
    seen.add(requestId)
    chips.push(chip)
  }
  return chips
}
