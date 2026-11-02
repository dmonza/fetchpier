/**
 * REQ-0074 — Desktop adapter for the local environment value layer
 * (`environments/<id>/.state/localvalues.json`). Orchestrates the pure core merge
 * (`@fetchpier/core` `secrets.mergeEnvironmentLayers`) with Electron-side key
 * custody (keystore, reveal gate).
 *
 * Responsibilities the CLI deliberately does NOT share (§2.3): lazy re-wrap after
 * a rotation pulled from elsewhere, orphan cleanup, and persisting script writes.
 * Those mutate the working tree and are desktop-only.
 */

import { secrets, workspace, CoreError } from '@fetchpier/core'
import { isReservedVariableName } from '../../shared/lib/dynamic-variables'
import type {
  Environment,
  EnvironmentChanges,
  EnvironmentLocalView,
  EnvironmentLocalViewRow
} from '../../shared/types'
import { getWorkspaceKey } from './keystore'
import { runRevealGate } from './reveal-gate'

/** Masked placeholder for a secret-named local value (plaintext never leaves main). */
const SECRET_MASK = '••••••••'

interface OrphanNotice {
  environmentId: string
  variables: string[]
}

/**
 * Read an environment's shared `variables` layer, tolerating a missing or
 * unreadable file (and an identifier that resolves to no folder) — the local
 * layer is still meaningful on its own, so this degrades to "no shared
 * variables" rather than throwing.
 *
 * Deliberately narrowed to `variables`: the fallback has no folder, and returning
 * a synthetic one would invite it to be used as a path.
 */
async function readEnvSafe(
  workspacePath: string,
  environmentId: string
): Promise<Pick<Environment, 'variables'>> {
  try {
    return await workspace.openWorkspace(workspacePath).environments.read(environmentId)
  } catch {
    return { variables: {} }
  }
}

/**
 * Normalize an environment's `localvalues.json` against the current workspace key:
 *
 *  - keyId matches (or nothing encrypted) → no-op.
 *  - keyId stale, old key retained in the keystore, current key available →
 *    **lazy re-wrap**: decrypt each encrypted value with the old key, re-encrypt
 *    with the current key, rewrite atomically under the new keyId. Silent.
 *  - keyId stale, old key absent → **orphan removal**: drop the encrypted entries,
 *    rewrite, and return a one-time notice. Resolution then falls back to shared.
 *  - keyId stale but current key locked → leave as-is (merge treats them as
 *    orphans for this load; a later unlocked load re-wraps).
 *
 * Returns the (possibly rewritten) local file, the current manifest keyId, and any
 * orphan notice.
 */
async function normalizeLocalValues(
  workspacePath: string,
  environmentId: string
): Promise<{
  local: secrets.LocalValuesFile
  currentKeyId: string | undefined
  orphanNotice?: OrphanNotice
}> {
  const manifest = await workspace.openWorkspace(workspacePath).secrets.readManifest()
  const currentKeyId = manifest?.encryption.keyId
  const local = await secrets.readLocalValues(workspacePath, environmentId)

  // Nothing to normalize: no keyId declared, or it already matches.
  if (!local.keyId || local.keyId === currentKeyId) {
    return { local, currentKeyId }
  }

  const encryptedNames = Object.entries(local.variables)
    .filter(([, v]) => secrets.isEncryptedValue(v))
    .map(([name]) => name)
  if (encryptedNames.length === 0) {
    // Stale keyId but nothing encrypted — drop the dangling keyId on next write.
    return { local: { ...local, keyId: undefined }, currentKeyId }
  }

  const oldKey = await getWorkspaceKey(local.keyId)
  const currentKey = currentKeyId ? await getWorkspaceKey(currentKeyId) : null

  if (oldKey && currentKey) {
    // Lazy re-wrap (§6.2 / CA-06).
    const nextValues: Record<string, string> = { ...local.variables }
    for (const name of encryptedNames) {
      const plaintext = await secrets.decryptValue(oldKey, name, local.variables[name])
      nextValues[name] = await secrets.encryptValue(currentKey, name, plaintext)
    }
    const rewritten: secrets.LocalValuesFile = {
      version: 1,
      keyId: currentKeyId,
      variables: nextValues
    }
    await secrets.writeLocalValues(workspacePath, environmentId, rewritten)
    return { local: rewritten, currentKeyId }
  }

  if (!oldKey) {
    // Orphan removal (§6.3 / CA-07 desktop): the old key is gone; the encrypted
    // overrides can never be recovered. Drop them and notify.
    const nextValues: Record<string, string> = {}
    for (const [name, value] of Object.entries(local.variables)) {
      if (!encryptedNames.includes(name)) nextValues[name] = value
    }
    const rewritten: secrets.LocalValuesFile = { version: 1, variables: nextValues }
    await secrets.writeLocalValues(workspacePath, environmentId, rewritten)
    return {
      local: rewritten,
      currentKeyId,
      orphanNotice: { environmentId, variables: encryptedNames }
    }
  }

  // Old key present but current locked — defer re-wrap; treat as orphans this load.
  return { local, currentKeyId }
}

export interface MergedEnvironmentResult {
  merged: secrets.MergedEnvironment
  /** Plain local values (overrides + local-only) to overlay onto `request.variables`. */
  localPlainOverlay: Record<string, string>
  orphanNotice?: OrphanNotice
}

/**
 * Resolve an environment's effective state: shared `config.json` overlaid by the
 * local layer, after any lazy re-wrap / orphan cleanup. The single desktop entry
 * point used by the send path and the editor.
 */
export async function loadMergedEnvironment(
  workspacePath: string,
  environmentId: string
): Promise<MergedEnvironmentResult> {
  const env = await readEnvSafe(workspacePath, environmentId)
  const { local, currentKeyId, orphanNotice } = await normalizeLocalValues(
    workspacePath,
    environmentId
  )
  const merged = secrets.mergeEnvironmentLayers({ variables: env.variables }, local, currentKeyId)

  const localPlainOverlay: Record<string, string> = {}
  for (const [name, value] of Object.entries(local.variables)) {
    if (secrets.classifyLocalWrite(name, env.variables) === 'plain') {
      localPlainOverlay[name] = value
    }
  }

  return { merged, localPlainOverlay, ...(orphanNotice ? { orphanNotice } : {}) }
}

/**
 * Persist script-written environment changes (§6.1) to the local layer. Replaces
 * the interim ephemeral path entirely — the shared `config.json` is never written
 * by a script (CA-02). Sticky secrecy (CA-03): a name that is a shared secret is
 * encrypted under the current key; plain and local-only names are plaintext.
 *
 * Throws `SECRETS_KEY_MISSING` when a secret-named write needs a key that is not
 * available — the send has already completed, so the caller reports this without
 * failing the response.
 */
export async function persistScriptEnvChanges(
  workspacePath: string,
  environmentId: string,
  changes: EnvironmentChanges | undefined
): Promise<void> {
  if (!changes) return
  const setNames = Object.keys(changes.set)
  if (setNames.length === 0 && changes.removed.length === 0) return

  const env = await readEnvSafe(workspacePath, environmentId)
  const { local, currentKeyId } = await normalizeLocalValues(workspacePath, environmentId)
  const nextVariables: Record<string, string> = { ...local.variables }
  let keyId = local.keyId ?? currentKeyId

  for (const [name, value] of Object.entries(changes.set)) {
    // REQ-0087: the `$` prefix is the reserved system dynamic-variable namespace.
    // Guard the local layer too (a script write is already rejected at the sandbox
    // chokepoint; this also covers a direct local-value editor write).
    if (isReservedVariableName(name)) {
      throw new CoreError(
        'RESERVED_VARIABLE_NAME',
        `Variable name "${name}" begins with "$", which is reserved for system dynamic variables.`,
        { environmentId, variable: name }
      )
    }
    if (secrets.classifyLocalWrite(name, env.variables) === 'secret') {
      if (!currentKeyId) {
        throw new CoreError('SECRETS_KEY_MISSING', 'This workspace has no secrets key yet.')
      }
      const key = await getWorkspaceKey(currentKeyId)
      if (!key) throw secrets.keyMissingError(name)
      nextVariables[name] = await secrets.encryptValue(key, name, value)
      keyId = currentKeyId
    } else {
      // REQ-0076: a plain write may not claim the reserved `enc:` prefix.
      if (secrets.isReservedPrefixValue(value)) {
        throw new CoreError(
          'WORKSPACE_INVALID',
          `Value for "${name}" starts with "enc:", which is reserved for encrypted secrets.`,
          { environmentId, variable: name }
        )
      }
      nextVariables[name] = value
    }
  }
  for (const name of changes.removed) delete nextVariables[name]

  await secrets.writeLocalValues(workspacePath, environmentId, {
    version: 1,
    ...(keyId ? { keyId } : {}),
    variables: nextVariables
  })
}

/** Set or replace a single local value from the editor (sticky secrecy applies). */
export async function setLocalValue(
  workspacePath: string,
  environmentId: string,
  name: string,
  value: string
): Promise<void> {
  await persistScriptEnvChanges(workspacePath, environmentId, {
    set: { [name]: value },
    removed: []
  })
}

/** Remove a local override/value (resolution falls back to shared, if any). */
export async function clearLocalValue(
  workspacePath: string,
  environmentId: string,
  name: string
): Promise<void> {
  await persistScriptEnvChanges(workspacePath, environmentId, { set: {}, removed: [name] })
}

/**
 * REQ-0075 §6.2 — seed the local layer for `name` with the *current resolved
 * shared value*, the divergence-gesture's creation path (unchecking Sync). The
 * renderer never supplies the value, so a secret's plaintext never crosses IPC
 * (CA-01): the main process reads the shared value and writes it through the
 * existing sticky-secrecy persist path (secret-named ⇒ re-encrypted under the
 * current key). For a shared `null` secret (needs-value) there is nothing to seed
 * — the editor opens an empty input instead — so this is a no-op.
 */
export async function seedLocalValue(
  workspacePath: string,
  environmentId: string,
  name: string
): Promise<void> {
  const env = await readEnvSafe(workspacePath, environmentId)
  const shared = env.variables[name]
  const isSharedSecret = shared === null || secrets.isEncryptedValue(shared)

  if (isSharedSecret) {
    if (shared === null || shared === undefined) return // needs-value: nothing to seed
    const manifest = await workspace.openWorkspace(workspacePath).secrets.readManifest()
    const currentKeyId = manifest?.encryption.keyId
    const key = currentKeyId ? await getWorkspaceKey(currentKeyId) : null
    if (!key) throw secrets.keyMissingError(name)
    let plaintext: string
    try {
      plaintext = await secrets.decryptValue(key, name, shared)
    } catch {
      throw secrets.valueCorruptError(environmentId, name)
    }
    await persistScriptEnvChanges(workspacePath, environmentId, {
      set: { [name]: plaintext },
      removed: []
    })
    return
  }

  if (shared === undefined || shared === null) return // no shared counterpart to follow (defensive)
  await persistScriptEnvChanges(workspacePath, environmentId, {
    set: { [name]: shared },
    removed: []
  })
}

/**
 * Reveal a single local value's plaintext (reveal-gated for secret-named entries).
 * Returns the decrypted value for secret-named overrides, or the plaintext for
 * plain/local-only entries. Throws when the gate is declined or the value is
 * absent/corrupt.
 */
export async function revealLocalValue(
  workspacePath: string,
  environmentId: string,
  name: string
): Promise<string> {
  const env = await readEnvSafe(workspacePath, environmentId)
  const { local, currentKeyId } = await normalizeLocalValues(workspacePath, environmentId)
  const value = local.variables[name]
  if (value === undefined) throw new CoreError('FILE_NOT_FOUND', `No local value "${name}".`)

  if (secrets.classifyLocalWrite(name, env.variables) !== 'secret') {
    return value // plain / local-only — no decryption needed
  }
  if (!secrets.isEncryptedValue(value)) throw secrets.valueCorruptError(environmentId, name)

  const granted = await runRevealGate(`Reveal the local value "${name}"`)
  if (!granted) throw new CoreError('REQUEST_CANCELLED', 'Reveal was not authorized.')

  const key = currentKeyId ? await getWorkspaceKey(currentKeyId) : null
  if (!key) throw secrets.keyMissingError(name)
  try {
    return await secrets.decryptValue(key, name, value)
  } catch {
    throw secrets.valueCorruptError(environmentId, name)
  }
}

/**
 * Propagate a shared-layer secrecy toggle to the local override (§6.4 / CA-10):
 *  - `becoming === 'secret'`: a plaintext local override is encrypted in place.
 *  - `becoming === 'plain'`: an encrypted local override is decrypted in place.
 * A no-op when there is no local entry for the name, or it is already in the
 * target form. Called from `setSecret`/`unsetSecret` so both layers stay coherent.
 */
export async function propagateSecrecyTransition(
  workspacePath: string,
  environmentId: string,
  name: string,
  becoming: 'secret' | 'plain'
): Promise<void> {
  const { local, currentKeyId } = await normalizeLocalValues(workspacePath, environmentId)
  const value = local.variables[name]
  if (value === undefined) return

  if (becoming === 'secret') {
    if (secrets.isEncryptedValue(value)) return
    if (!currentKeyId)
      throw new CoreError('SECRETS_KEY_MISSING', 'This workspace has no secrets key yet.')
    const key = await getWorkspaceKey(currentKeyId)
    if (!key) throw secrets.keyMissingError(name)
    const nextVariables = {
      ...local.variables,
      [name]: await secrets.encryptValue(key, name, value)
    }
    await secrets.writeLocalValues(workspacePath, environmentId, {
      version: 1,
      keyId: currentKeyId,
      variables: nextVariables
    })
    return
  }

  // becoming === 'plain'
  if (!secrets.isEncryptedValue(value)) return
  const key = currentKeyId ? await getWorkspaceKey(currentKeyId) : null
  if (!key) throw secrets.keyMissingError(name)
  let plaintext: string
  try {
    plaintext = await secrets.decryptValue(key, name, value)
  } catch {
    throw secrets.valueCorruptError(environmentId, name)
  }
  const nextVariables = { ...local.variables, [name]: plaintext }
  await secrets.writeLocalValues(workspacePath, environmentId, {
    version: 1,
    keyId: local.keyId,
    variables: nextVariables
  })
}

/** Build the editor's Shared | Local view for an environment. */
export async function getLocalView(
  workspacePath: string,
  environmentId: string
): Promise<EnvironmentLocalView> {
  const env = await readEnvSafe(workspacePath, environmentId)
  const { local, currentKeyId, orphanNotice } = await normalizeLocalValues(
    workspacePath,
    environmentId
  )
  const merged = secrets.mergeEnvironmentLayers({ variables: env.variables }, local, currentKeyId)

  const names = new Set<string>([
    ...Object.keys(env.variables ?? {}),
    ...Object.keys(local.variables)
  ])

  // Key for the secret-divergence comparison (REQ-0075). Fetched once; `null` when
  // the workspace is locked or has no manifest — then secret overrides are reported
  // divergent (conservative: the re-check confirmation is shown rather than skipped).
  const currentKey = currentKeyId ? await getWorkspaceKey(currentKeyId) : null

  const rows: EnvironmentLocalViewRow[] = []
  for (const name of names) {
    // REQ-0076: secrecy is derived from the shared value's *shape* (`null`/`enc:`).
    const sharedHasName = Object.prototype.hasOwnProperty.call(env.variables, name)
    const sharedValue = sharedHasName ? env.variables[name] : undefined
    const isSharedSecret =
      sharedHasName && (sharedValue === null || secrets.isEncryptedValue(sharedValue))
    const sharedKind: EnvironmentLocalViewRow['sharedKind'] = !sharedHasName
      ? 'absent'
      : isSharedSecret
        ? 'secret'
        : 'plain'
    const hasLocalEntry = Object.prototype.hasOwnProperty.call(local.variables, name)
    const orphan = merged.orphans.includes(name)
    const invalid = merged.invalid.includes(name)
    const hasLocalOverride = hasLocalEntry && !orphan && !invalid
    const localOnly = sharedKind === 'absent' && hasLocalEntry

    // Does the applied override resolve to something different from shared? Only an
    // applied override can diverge; synced / local-only / orphan / invalid are `false`.
    let divergent = false
    if (hasLocalOverride) {
      if (sharedKind === 'plain') {
        divergent = local.variables[name] !== (sharedValue ?? '')
      } else if (sharedKind === 'secret') {
        const shared = sharedValue ?? null
        if (shared === null || !currentKey) {
          // Returning goes to needs-value, or we cannot decrypt to compare — confirm.
          divergent = true
        } else {
          try {
            const localPlain = await secrets.decryptValue(currentKey, name, local.variables[name])
            const sharedPlain = await secrets.decryptValue(currentKey, name, shared)
            divergent = localPlain !== sharedPlain
          } catch {
            divergent = true
          }
        }
      }
    }

    rows.push({
      name,
      sharedKind,
      hasLocalOverride,
      localOnly,
      orphan,
      invalid,
      divergent,
      // Never expose secret plaintext: mask for secret-named, raw for plain/local-only.
      ...(hasLocalEntry
        ? { localDisplay: isSharedSecret ? SECRET_MASK : local.variables[name] }
        : {})
    })
  }

  rows.sort((a, b) => a.name.localeCompare(b.name))
  return { environmentId, rows, ...(orphanNotice ? { orphanNotice } : {}) }
}

/**
 * Build a rotation write-entry for an environment's `localvalues.json` (§6.7 / CA-08).
 * Decrypts each encrypted value with `oldKey`, re-encrypts with `newKey`, and
 * returns a `{ finalPath, tmpPath, content }` to fold into `rotateKey`'s atomic
 * temp-then-rename batch. Returns `null` when there is nothing encrypted to carry.
 */
export async function reWrapLocalValuesForRotation(
  workspacePath: string,
  environmentId: string,
  oldKey: Uint8Array,
  newKey: Uint8Array,
  newKeyId: string,
  stamp: string
): Promise<{ finalPath: string; tmpPath: string; content: string } | null> {
  const local = await secrets.readLocalValues(workspacePath, environmentId)
  const encryptedNames = Object.entries(local.variables)
    .filter(([, v]) => secrets.isEncryptedValue(v))
    .map(([name]) => name)
  if (encryptedNames.length === 0) return null

  const nextValues: Record<string, string> = { ...local.variables }
  for (const name of encryptedNames) {
    const plaintext = await secrets.decryptValue(oldKey, name, local.variables[name])
    nextValues[name] = await secrets.encryptValue(newKey, name, plaintext)
  }
  const rewritten: secrets.LocalValuesFile = { version: 1, keyId: newKeyId, variables: nextValues }
  const finalPath = await secrets.resolveLocalValuesPath(workspacePath, environmentId)
  return {
    finalPath,
    tmpPath: `${finalPath}.rotate-${stamp}`,
    content: `${JSON.stringify(rewritten, null, 2)}\n`
  }
}
