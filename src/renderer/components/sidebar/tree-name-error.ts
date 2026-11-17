import { parseCascadeRollbackPaths } from '@shared/lib/cascade-rollback'

type Translate = (key: string, opts?: { name?: string; paths?: string }) => string

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

/** How long the toast naming files left behind stays up: the user has to act on it. */
const ROLLBACK_FAILED_TOAST_MS = 10_000

/**
 * The toast for a failed tree rename or move (Rename, Move to…, drag and drop).
 * Every failure says so (ISS-0175: a rename used to only log one). When the
 * core could not undo a cascade that failed half-way (`CASCADE_ROLLBACK_FAILED`)
 * the toast names the files left at their new location, and stays longer.
 * Otherwise the operation changed nothing, and the message is the operation's
 * own: the name and `MOVE_*` tokens, or the generic one.
 */
export function treeMutationErrorToast(
  err: unknown,
  op: 'rename' | 'move',
  name: string,
  t: Translate
): { message: string; durationMs?: number } {
  const msg = err instanceof Error ? err.message : String(err)
  const stranded = parseCascadeRollbackPaths(msg)
  if (stranded) {
    return {
      message: t('collection.errors.cascadeRollbackFailed', { paths: stranded.join(', ') }),
      durationMs: ROLLBACK_FAILED_TOAST_MS
    }
  }
  if (op === 'rename') {
    return { message: treeNameErrorMessage(err, name, t) ?? t('collection.errors.rename') }
  }
  if (msg.includes('MOVE_CONFLICT'))
    return { message: t('collection.errors.moveConflict', { name }) }
  if (msg.includes('MOVE_INTO_SELF')) return { message: t('collection.errors.moveIntoItself') }
  return { message: t('collection.errors.move') }
}
