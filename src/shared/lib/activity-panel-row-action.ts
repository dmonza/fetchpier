import type { ActivityPanelRowAction } from '../types'

/**
 * Validation of a History row action the Activity popout forwards to the main
 * window that owns it (ISS-0164). Main runs it on every `activityPanel:openInOwner`
 * payload before forwarding; it returns a fresh object holding only the fields
 * the kind carries, or `null` for anything else.
 *
 * It checks shape only. Main additionally resolves `sourceFile` inside the
 * active workspace, and the owner reads the run through its own IPC.
 */

/** Longest run id accepted (run ids are UUIDs; the limit only bounds input). */
export const MAX_ENTRY_ID_LENGTH = 256
/** Longest workspace-relative source path accepted. */
export const MAX_SOURCE_FILE_LENGTH = 4096
/** Longest method / URL accepted for a Raw tab's title. */
const MAX_TITLE_PART_LENGTH = 8192

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/
const ABSOLUTE_PATH = /^(?:[/\\]|[a-zA-Z]:)/

/**
 * A string of at most `max` characters with no control character (non-empty
 * unless `allowEmpty`). Shared with the chip-mirror validator.
 */
export function isText(value: unknown, max: number, allowEmpty = false): value is string {
  return (
    typeof value === 'string' &&
    (allowEmpty || value.length > 0) &&
    value.length <= max &&
    !CONTROL_CHARACTER.test(value)
  )
}

/** A workspace-relative path: bounded text, not absolute, no `..` segment. */
export function isRelativeSourcePath(value: unknown): value is string {
  return (
    isText(value, MAX_SOURCE_FILE_LENGTH) &&
    !ABSOLUTE_PATH.test(value) &&
    !value.split(/[/\\]/).includes('..')
  )
}

export function parseActivityPanelRowAction(value: unknown): ActivityPanelRowAction | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  switch (v.kind) {
    case 'view':
    case 'repeat':
      return isText(v.entryId, MAX_ENTRY_ID_LENGTH) ? { kind: v.kind, entryId: v.entryId } : null
    case 'raw':
      return isText(v.entryId, MAX_ENTRY_ID_LENGTH) &&
        isText(v.method, MAX_TITLE_PART_LENGTH, true) &&
        isText(v.url, MAX_TITLE_PART_LENGTH, true)
        ? { kind: 'raw', entryId: v.entryId, method: v.method, url: v.url }
        : null
    case 'open-source-file':
      return isRelativeSourcePath(v.sourceFile)
        ? { kind: 'open-source-file', sourceFile: v.sourceFile }
        : null
    default:
      return null
  }
}
