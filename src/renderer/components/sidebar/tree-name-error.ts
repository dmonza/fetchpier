type Translate = (key: string, opts: { name: string }) => string

/**
 * The message the sidebar shows when creating or renaming an entry fails on its
 * name: a name that is not valid on every operating system (`INVALID_ENTRY_NAME`)
 * or one already taken in the folder (`*_NAME_CONFLICT`). The core throws these
 * tokens; the IPC boundary may wrap the message, so they are matched as
 * substrings. Any other error returns null and stays the caller's to handle.
 */
export function treeNameErrorMessage(err: unknown, name: string, t: Translate): string | null {
  const msg = err instanceof Error ? err.message : String(err)
  if (msg.includes('INVALID_ENTRY_NAME')) return t('collection.errors.invalidEntryName', { name })
  if (msg.includes('REQUEST_NAME_CONFLICT') || msg.includes('COLLECTION_NAME_CONFLICT')) {
    return t('collection.errors.nameConflict', { name })
  }
  return null
}
