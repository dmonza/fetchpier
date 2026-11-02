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

/** Delete is enabled only once the typed input matches the token exactly (after trim). */
export function canConfirmKeyDelete(typed: string, token: string): boolean {
  return typed.trim() === token
}
