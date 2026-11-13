/**
 * REQ write-safety §6.4 — pure decision logic for the guarded key-delete dialog,
 * shared so it can be unit-tested without mounting the dialog.
 */

/** The exact token the user must type to confirm: the workspace name, or the key id when unnamed. */
export function keyDeleteToken(entry: { workspaceHint?: string; keyId: string }): string {
  return entry.workspaceHint?.trim() || entry.keyId
}

/** Blocked when a positive local reference exists (a known workspace still uses the key). */
export function isKeyDeleteBlocked(usedBy: string[] | undefined): boolean {
  return !!usedBy && usedBy.length > 0
}

/**
 * SEC-12: the workspace names of main's `KEY_IN_USE: <names>` refusal (the
 * boundary re-checks references at call time), or `null` for any other failure.
 * Tolerates the prefix Electron adds to an IPC rejection.
 */
export function keyInUseNames(err: unknown): string[] | null {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const match = /KEY_IN_USE:(.*)$/s.exec(message)
  if (!match) return null
  const names = match[1]
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean)
  return names.length > 0 ? names : null
}

/** Delete is enabled only once the typed input matches the token exactly (after trim). */
export function canConfirmKeyDelete(typed: string, token: string): boolean {
  return typed.trim() === token
}
