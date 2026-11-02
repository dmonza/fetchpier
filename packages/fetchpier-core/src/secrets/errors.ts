/**
 * REQ-0070 — Factories for the contractual secrets errors (§7.1). Centralizes
 * the messages so desktop IPC and CLI surface identical, env/variable-named text.
 */

import { CoreError } from '../shared/context'

/** A referenced secret needs a key and none is available (locked / no env var). */
export function keyMissingError(varName?: string): CoreError {
  const where = varName ? ` (needed by "${varName}")` : ''
  return new CoreError(
    'SECRETS_KEY_MISSING',
    `No workspace key available to decrypt secret variables${where}. ` +
      `Enter the key in the app or set FETCHPIER_WORKSPACE_KEY.`,
    varName ? { variable: varName } : undefined
  )
}

/** The provided key fails the format CRC or the workspace challenge. */
export function keyInvalidError(expectedKeyId?: string): CoreError {
  const hint = expectedKeyId ? ` Expected keyId ${expectedKeyId}.` : ''
  return new CoreError(
    'SECRETS_KEY_INVALID',
    `The workspace key is not valid for this workspace.${hint}`,
    expectedKeyId ? { expectedKeyId } : undefined
  )
}

/** A value fails parsing/authentication; names the environment and variable. */
export function valueCorruptError(
  environmentId: string,
  varName: string,
  reason?: string
): CoreError {
  return new CoreError(
    'SECRETS_VALUE_CORRUPT',
    `Secret "${varName}" in environment "${environmentId}" could not be decrypted ` +
      `(${reason ?? 'authentication failed'}) — possible tampering or wrong key for this value.`,
    { environmentId, variable: varName, reason }
  )
}

/** A referenced secret is `null` (needs-value); detectable without a key. */
export function valueUnsetError(environmentId: string, varName: string): CoreError {
  return new CoreError(
    'SECRETS_VALUE_UNSET',
    `Secret "${varName}" in environment "${environmentId}" has no value in this workspace ` +
      `(needs-value). Enter a value in the environment editor.`,
    { environmentId, variable: varName }
  )
}
