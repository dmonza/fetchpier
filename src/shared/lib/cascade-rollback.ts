/**
 * The message a tree rename/move rejects with when its instance cascade failed
 * **and** undoing it failed too, so some files stayed at their new location.
 * Shared by the core (which formats it) and the renderer (which parses it for
 * the toast): the error crosses the IPC boundary as its message only, so the
 * stranded paths travel inside it.
 *
 * Shape: the token and a human-readable reason on the first line, then a JSON
 * array of workspace-relative, forward-slash paths on a line of its own. JSON
 * keeps any character a file name may hold on that single line.
 */
export const CASCADE_ROLLBACK_FAILED = 'CASCADE_ROLLBACK_FAILED'

export function formatCascadeRollbackMessage(
  op: 'rename' | 'move',
  source: string,
  reason: string,
  strandedPaths: readonly string[]
): string {
  const head = `${CASCADE_ROLLBACK_FAILED}: ${op} of "${source}" failed (${reason}) and could not be fully undone; left at their new location:`
  return `${head}\n${JSON.stringify(strandedPaths)}`
}

/**
 * The stranded paths carried by a `CASCADE_ROLLBACK_FAILED` message (also when
 * wrapped by the IPC boundary), or null when the message is another error or
 * carries no non-empty list of strings.
 */
export function parseCascadeRollbackPaths(message: string): string[] | null {
  const at = message.indexOf(CASCADE_ROLLBACK_FAILED)
  if (at < 0) return null
  for (const line of message.slice(at).split('\n').slice(1)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('[')) continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.every((p): p is string => typeof p === 'string')
      ) {
        return parsed
      }
    } catch {
      // not the list line
    }
    return null
  }
  return null
}
