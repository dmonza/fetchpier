/**
 * REQ-0070 — Desktop secrets service. Orchestrates the pure core crypto with
 * Electron-specific key custody (keystore, reveal gate). The IPC handlers in
 * `secrets.ipc.ts` are thin wrappers over this module.
 *
 * Workspace I/O (manifest + environment config) goes through the core handle
 * (`workspace.openWorkspace(path)`); only the cross-file rotation batch uses the
 * generic `workspace.atomicWriteBatch` primitive. The crypto stays here.
 */

import { basename, resolve } from 'node:path'
import { secrets, workspace, CoreError } from '@fetchpier/core'
import { isReservedVariableName } from '../../shared/lib/dynamic-variables'
import type {
  Environment,
  HttpRequest,
  SecretsEnterKeyResult,
  SecretsSetupResult,
  SecretsStatus
} from '../../shared/types'
import type {
  SecretsAddKeyResult,
  WorkspaceKeyMetadata,
  WorkspaceKeysListing
} from '../../shared/types'
import { detectBackend } from './backend'
import {
  clearSessionMeta,
  findKeyMetadata,
  getWorkspaceKey,
  listKeyEntries,
  peekKeyMaterial,
  removeKey,
  setKeyHint,
  storeWorkspaceKey
} from './keystore'
import { lockAll } from './unlock-state'
import { computeReferences } from './references'
import {
  clearLocalValue,
  propagateSecrecyTransition,
  reWrapLocalValuesForRotation
} from './local-values'
import { getRecentWorkspacePaths } from '../state/recent-workspaces'
import { resetGrace, runRevealGate } from './reveal-gate'

/** Lock the workspace: drop live keys, session metadata, and the reveal grace. */
export function lockAllSecrets(): void {
  lockAll()
  clearSessionMeta()
  resetGrace()
}

function workspaceHint(workspacePath: string): string {
  return basename(workspacePath)
}

/** Read the workspace's secret-encryption status. */
export async function getStatus(workspacePath: string): Promise<SecretsStatus> {
  const backend = detectBackend()
  const manifest = await workspace.openWorkspace(workspacePath).secrets.readManifest()
  if (!manifest) return { hasManifest: false, unlocked: false, backend }
  const key = await getWorkspaceKey(manifest.encryption.keyId)
  return {
    hasManifest: true,
    unlocked: key !== null,
    backend,
    keyId: manifest.encryption.keyId
  }
}

/**
 * First-time setup: generate the workspace key, write the manifest, store the
 * key, and return the `FPK1-…` form for the one-time backup dialog. Throws if a
 * manifest already exists (the caller should drive enter-key instead).
 */
export async function setupKey(workspacePath: string): Promise<SecretsSetupResult> {
  return withWorkspaceKeyLock(workspacePath, async () => {
    const ws = workspace.openWorkspace(workspacePath)
    // Re-checked inside the lock: a second setup queued behind the first (a double
    // click) sees its manifest instead of minting another key.
    const existing = await ws.secrets.readManifest()
    if (existing) {
      throw new CoreError('WORKSPACE_INVALID', 'This workspace already has a secrets key.')
    }
    const rawKey = await secrets.generateWorkspaceKey()
    const manifest = await secrets.buildManifest(rawKey)
    await ws.secrets.writeManifest(manifest)
    await storeWorkspaceKey(manifest.encryption.keyId, rawKey, workspaceHint(workspacePath))
    return { key: secrets.formatKey(rawKey), keyId: manifest.encryption.keyId }
  })
}

/**
 * Per-workspace promise lock for the operations that mint a key and move the
 * manifest (setup, rotate). Unserialized, two setups both saw "no manifest",
 * each generated a key, and the manifest and the keystore could end on different
 * keys — the backup key the dialog showed no longer opened the workspace.
 */
const keyLocks = new Map<string, Promise<unknown>>()

function withWorkspaceKeyLock<T>(workspacePath: string, fn: () => Promise<T>): Promise<T> {
  const lockKey = resolve(workspacePath)
  const previous = keyLocks.get(lockKey) ?? Promise.resolve()
  const run = previous.then(fn, fn)
  const tail = run.catch(() => undefined)
  keyLocks.set(lockKey, tail)
  void tail.then(() => {
    if (keyLocks.get(lockKey) === tail) keyLocks.delete(lockKey)
  })
  return run
}

/** SEC-09: a `$` name is the reserved dynamic-variable namespace — never a secret. */
function assertNotReserved(name: string): void {
  if (isReservedVariableName(name)) {
    throw new CoreError(
      'RESERVED_VARIABLE_NAME',
      `Variable name "${name}" begins with "$", which is reserved for system dynamic variables.`,
      { variable: name }
    )
  }
}

/** Validate and store a pasted `FPK1-…` key against the workspace challenge. */
export async function enterKey(
  workspacePath: string,
  keyInput: string
): Promise<SecretsEnterKeyResult> {
  const manifest = await workspace.openWorkspace(workspacePath).secrets.readManifest()
  if (!manifest) return { ok: false, reason: 'no-manifest' }

  let rawKey: Uint8Array
  try {
    rawKey = secrets.parseKey(keyInput)
  } catch {
    return { ok: false, reason: 'invalid-format', keyId: manifest.encryption.keyId }
  }
  if (!(await secrets.verifyKeyAgainstChallenge(rawKey, manifest))) {
    return { ok: false, reason: 'wrong-key', keyId: manifest.encryption.keyId }
  }
  await storeWorkspaceKey(manifest.encryption.keyId, rawKey, workspaceHint(workspacePath))
  return { ok: true, keyId: manifest.encryption.keyId }
}

/** Resolve the unlocked workspace key, or throw `SECRETS_KEY_MISSING`. */
async function requireKey(ws: workspace.Workspace): Promise<Uint8Array> {
  const manifest = await ws.secrets.readManifest()
  if (!manifest) {
    throw new CoreError('SECRETS_KEY_MISSING', 'This workspace has no secrets key yet.')
  }
  const key = await getWorkspaceKey(manifest.encryption.keyId)
  if (!key) throw secrets.keyMissingError()
  return key
}

async function readEnv(ws: workspace.Workspace, environmentId: string): Promise<Environment> {
  return ws.environments.read(environmentId)
}

/** REQ-0076: the secret-shaped (`enc:`/`null`) entries of a unified `variables` map. */
function secretShapedOnly(variables: Record<string, string | null>): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const [name, value] of Object.entries(variables)) {
    if (value === null || secrets.isEncryptedValue(value)) out[name] = value
  }
  return out
}

/**
 * Reveal a single secret's plaintext (the only operation that returns plaintext
 * to the renderer). Runs the re-auth gate first. Throws when locked, when the
 * gate is declined, or when the value is unset/corrupt.
 */
export async function revealValue(
  workspacePath: string,
  environmentId: string,
  name: string
): Promise<string> {
  const ws = workspace.openWorkspace(workspacePath)
  const key = await requireKey(ws)
  const env = await readEnv(ws, environmentId)
  const value = env.variables[name]
  if (value === undefined) throw new CoreError('FILE_NOT_FOUND', `No secret "${name}".`)
  if (value === null) throw secrets.valueUnsetError(environmentId, name)

  const granted = await runRevealGate(`Reveal the secret "${name}"`)
  if (!granted) throw new CoreError('REQUEST_CANCELLED', 'Reveal was not authorized.')

  try {
    return await secrets.decryptValue(key, name, value)
  } catch {
    throw secrets.valueCorruptError(environmentId, name)
  }
}

/**
 * Mark a variable secret (or set/replace a secret's value): encrypt `plaintext`
 * (AD = name) and write the ciphertext into `variables` **in place** (REQ-0076 —
 * one unified map; the key neither moves nor duplicates). Returns the updated
 * environment (with `enc:` ciphertext, never plaintext).
 */
export async function setSecret(
  workspacePath: string,
  environmentId: string,
  name: string,
  plaintext: string
): Promise<Environment> {
  assertNotReserved(name)
  const ws = workspace.openWorkspace(workspacePath)
  const key = await requireKey(ws)
  const env = await readEnv(ws, environmentId)
  const enc = await secrets.encryptValue(key, name, plaintext)
  const updated: Environment = { ...env, variables: { ...env.variables, [name]: enc } }
  await ws.environments.write(updated)
  // REQ-0074 §6.4: a plaintext local override for this name is now secret-named,
  // so encrypt it in place (the variable's secrecy covers all layers).
  await propagateSecrecyTransition(workspacePath, environmentId, name, 'secret')
  return updated
}

/**
 * Author a needs-value secret, or clear a corrupt one ("Clear and re-enter").
 *
 * REQ-0108 §6.10 — this is also the path that locks an *unshared* variable: the name
 * reaches `config.json` as a needs-value secret and never carries the local value with
 * it (§6.1). Because the name is now secret, a plaintext local value for it must be
 * encrypted in place — secrecy is a property of the variable, not of a layer. The
 * shared write commits first so the local layer is never encrypted against a shared
 * entry that does not exist; the transition is a no-op when the local value is already
 * ciphertext or absent.
 */
export async function clearSecret(
  workspacePath: string,
  environmentId: string,
  name: string
): Promise<Environment> {
  assertNotReserved(name)
  const ws = workspace.openWorkspace(workspacePath)
  const env = await readEnv(ws, environmentId)
  const updated: Environment = { ...env, variables: { ...env.variables, [name]: null } }
  await ws.environments.write(updated)
  await propagateSecrecyTransition(workspacePath, environmentId, name, 'secret')
  return updated
}

/**
 * REQ-0077 — delete a secret variable directly. Removes `name` from the unified
 * `variables` map of `config.json` (the ciphertext is discarded as-is — **never
 * decrypted**, so no key is required) and removes any local override in
 * `localvalues.json` (the file is unlinked when it becomes empty). The workspace
 * key is never touched. Idempotent: deleting an absent name is a no-op success.
 *
 * Deletion spans both layers because a targeted credential removal is deliberate;
 * demoting a now-orphaned encrypted override to local-only (the §6.4 *plain*-variable
 * rule) would be purposeless here. The shared deletion is the primary intent and is
 * not rolled back if the local override write fails (the leftover local entry is
 * then surfaced by the editor's existing orphan handling).
 */
export async function deleteSecret(
  workspacePath: string,
  environmentId: string,
  name: string
): Promise<Environment> {
  const ws = workspace.openWorkspace(workspacePath)
  const env = await readEnv(ws, environmentId)
  const nextVariables = { ...env.variables }
  delete nextVariables[name]
  const updated: Environment = { ...env, variables: nextVariables }
  await ws.environments.write(updated)
  await clearLocalValue(workspacePath, environmentId, name)
  return updated
}

/**
 * Turn a secret back into a plaintext variable (decrypt in place). The caller is
 * responsible for the plaintext-commit confirmation (§6.1). A needs-value
 * secret becomes an empty plain variable.
 */
export async function unsetSecret(
  workspacePath: string,
  environmentId: string,
  name: string
): Promise<Environment> {
  const ws = workspace.openWorkspace(workspacePath)
  const env = await readEnv(ws, environmentId)
  const value = env.variables[name]
  let plaintext = ''
  if (typeof value === 'string' && secrets.isEncryptedValue(value)) {
    const key = await requireKey(ws)
    try {
      plaintext = await secrets.decryptValue(key, name, value)
    } catch {
      throw secrets.valueCorruptError(environmentId, name)
    }
  } else if (typeof value === 'string') {
    plaintext = value // already plain — idempotent
  }
  const updated: Environment = { ...env, variables: { ...env.variables, [name]: plaintext } }
  await ws.environments.write(updated)
  // REQ-0074 §6.4: the name is no longer secret — decrypt its local override in place.
  await propagateSecrecyTransition(workspacePath, environmentId, name, 'plain')
  return updated
}

/**
 * Build a {@link SecretMasker} for a send: resolve the secrets the request
 * references, seeded against the unlocked workspace key. Returns undefined when
 * the workspace has no secrets or the request references none (lazy — no key
 * needed). Throws the contractual `SECRETS_*` errors otherwise.
 */
export async function buildSendMasker(
  workspacePath: string,
  environmentId: string | null,
  request: HttpRequest,
  /**
   * REQ-0074: the merged (shared ⊕ local) secret map. When provided, local
   * encrypted overrides have already won over shared and any re-wrap/orphan
   * normalization has run. Falls back to the shared map alone for callers that
   * do not resolve the local layer.
   */
  mergedSecretsMap?: Record<string, string | null>
): Promise<secrets.SecretMasker | undefined> {
  if (!environmentId) return undefined
  const ws = workspace.openWorkspace(workspacePath)
  const manifest = await ws.secrets.readManifest()
  if (!manifest) return undefined

  const secretsMap =
    mergedSecretsMap ?? secretShapedOnly((await readEnv(ws, environmentId)).variables)
  if (!secretsMap || Object.keys(secretsMap).length === 0) return undefined

  const neededNames = secrets.collectReferencedVariableNames(request)
  const referencesSecret = [...neededNames].some((n) =>
    Object.prototype.hasOwnProperty.call(secretsMap, n)
  )
  if (!referencesSecret) return undefined

  const key = await getWorkspaceKey(manifest.encryption.keyId)
  const plaintextByName = await secrets.resolveSecrets({
    environmentId,
    secretsMap,
    neededNames,
    hasKey: key !== null,
    decrypt: (name, encValue) => secrets.decryptValue(key as Uint8Array, name, encValue)
  })
  if (Object.keys(plaintextByName).length === 0) return undefined
  return secrets.createSecretMasker({ nonce: secrets.mintExecutionNonce(), plaintextByName })
}

/**
 * REQ-0089: decrypt the workspace secrets a client-certificate passphrase
 * references, under the unlocked key. Bound into the TLS resolver and invoked
 * lazily — only after a workspace certificate with a secret-referencing
 * passphrase is matched. Returns plaintext for the referenced *secret* names
 * only (plain references resolve from the environment in core); throws the
 * contractual `SECRETS_*` errors before the handshake. No-op (no key needed)
 * when none of the names is a secret.
 */
export async function resolvePassphraseSecrets(
  workspacePath: string,
  environmentId: string | null,
  names: string[],
  mergedSecretsMap?: Record<string, string | null>
): Promise<Record<string, string>> {
  if (!environmentId || names.length === 0) return {}
  const ws = workspace.openWorkspace(workspacePath)
  const manifest = await ws.secrets.readManifest()
  if (!manifest) return {}

  const secretsMap =
    mergedSecretsMap ?? secretShapedOnly((await readEnv(ws, environmentId)).variables)
  const referencesSecret = names.some((n) => Object.prototype.hasOwnProperty.call(secretsMap, n))
  if (!referencesSecret) return {}

  const key = await getWorkspaceKey(manifest.encryption.keyId)
  return secrets.resolveSecrets({
    environmentId,
    secretsMap,
    neededNames: names,
    hasKey: key !== null,
    decrypt: (name, encValue) => secrets.decryptValue(key as Uint8Array, name, encValue)
  })
}

/**
 * Rotate the workspace key (§6.7): generate a new key, re-encrypt every secret
 * across all environments and the challenge, update keyId, store + return the
 * new key. Atomic across files: everything is re-encrypted to temp files first,
 * then renamed together. A single corrupt value aborts before any rename, naming
 * the offending environment/variable, and the workspace stays fully on the old
 * key. The old keystore entry is retained (harmless; other checkouts keep
 * unlocking until they pull).
 */
export async function rotateKey(workspacePath: string): Promise<SecretsSetupResult> {
  return withWorkspaceKeyLock(workspacePath, () => rotateKeyLocked(workspacePath))
}

async function rotateKeyLocked(workspacePath: string): Promise<SecretsSetupResult> {
  const ws = workspace.openWorkspace(workspacePath)
  const oldKey = await requireKey(ws)
  const newKey = await secrets.generateWorkspaceKey()

  // New manifest (fresh challenge + keyId). Built first so the local-layer
  // re-wrap (REQ-0074) can stamp the new keyId into each `localvalues.json`.
  const manifest = await secrets.buildManifest(newKey)
  const newKeyId = manifest.encryption.keyId

  // Re-encrypt everything in memory; collect (finalPath, tmpPath, content).
  const writes: Array<{ finalPath: string; tmpPath: string; content: string }> = []
  const stamp = `${process.pid}-${Date.now()}`

  // An environment whose `config.json` exists but cannot be read would keep its
  // secrets under the old key while the manifest moves on — unrecoverable once
  // the file is readable again. Refuse before building any write.
  const { environments, unreadable } = await ws.environments.listWithErrors()
  if (unreadable.length > 0) {
    const names = unreadable.map((u) => `"${u.folder}" (${u.file}: ${u.reason})`).join(', ')
    throw new CoreError(
      'WORKSPACE_INVALID',
      `The workspace key was not rotated: these environments could not be read: ${names}. ` +
        `Fix them and rotate again.`,
      { unreadable: unreadable.map((u) => u.folder) }
    )
  }

  for (const env of environments) {
    // The listing already carries the folder each config was found in, so the path
    // is built from that rather than from the opaque identifier.
    const configPath = ws.environments.configPath(env.folder)

    // REQ-0076: re-encrypt every `enc:` value in the unified `variables` map in
    // place (plain and `null` entries are carried verbatim).
    const encNames = Object.entries(env.variables).filter(
      ([, v]) => typeof v === 'string' && secrets.isEncryptedValue(v)
    )
    if (encNames.length > 0) {
      const nextVariables: Record<string, string | null> = { ...env.variables }
      for (const [name, value] of encNames) {
        let plaintext: string
        try {
          plaintext = await secrets.decryptValue(oldKey, name, value as string)
        } catch {
          throw secrets.valueCorruptError(env.id, name)
        }
        nextVariables[name] = await secrets.encryptValue(newKey, name, plaintext)
      }
      // Serialize the config shape explicitly: `folder` is derived from the
      // path the config was read from and must never land inside the file.
      const updated = { id: env.id, name: env.name, variables: nextVariables }
      writes.push({
        finalPath: configPath,
        tmpPath: `${configPath}.rotate-${stamp}`,
        content: `${JSON.stringify(updated, null, 2)}`
      })
    }

    // REQ-0074 §6.7/CA-08: carry the local layer in the same atomic flow. A
    // corrupt local value aborts the whole rotation before any rename, naming
    // the variable.
    const localWrite = await reWrapLocalValuesForRotation(
      workspacePath,
      env.id,
      oldKey,
      newKey,
      newKeyId,
      stamp
    )
    if (localWrite) writes.push(localWrite)
  }

  const manifestPath = ws.secrets.manifestPath()
  writes.push({
    finalPath: manifestPath,
    tmpPath: `${manifestPath}.rotate-${stamp}`,
    content: secrets.serializeManifest(manifest)
  })

  // Two-phase atomic batch (write all temps, then rename) — owned by core so the
  // adapter performs no direct workspace fs (REQ Core-owned workspace handle). The
  // crypto (decrypt/encrypt above) stays here; only the batch I/O moved.
  await workspace.atomicWriteBatch(writes)

  await storeWorkspaceKey(manifest.encryption.keyId, newKey, workspaceHint(workspacePath))
  return { key: secrets.formatKey(newKey), keyId: manifest.encryption.keyId }
}

// ── REQ-0073: Workspace keys management surface ──────────────────────────────

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

async function metadataOrThrow(keyId: string): Promise<WorkspaceKeyMetadata> {
  const entry = await findKeyMetadata(keyId)
  if (!entry) throw new CoreError('WORKSPACE_INVALID', 'Workspace key was not stored.')
  return entry
}

/**
 * List the machine-local keystore as metadata only, with the reference mark
 * computed fresh against the recent workspaces. Reads no key material and never
 * unwraps — opening the tab never prompts the keychain/passphrase (§5.2, §8).
 * Independent of any active workspace.
 */
export async function listKeys(): Promise<WorkspaceKeysListing> {
  const entries = await listKeyEntries()
  const references = await computeReferences(await getRecentWorkspacePaths())
  return { entries, references }
}

/**
 * Forget a key on this machine only (keystore + session + live cache).
 *
 * Guarded (REQ write-safety): refuse while the key is *known* to be in use — a
 * positive local reference from a recent workspace's manifest. Absence of a
 * reference never blocks (it cannot be proven across machines); the renderer
 * gates that path behind a typed confirmation instead. Defense in depth: the
 * dialog already steers the user, but the boundary enforces the block too.
 */
export async function deleteKey(keyId: string): Promise<void> {
  const references = await computeReferences(await getRecentWorkspacePaths())
  const usedBy = references.byKeyId[keyId]
  if (usedBy && usedBy.length > 0) {
    throw new Error(`KEY_IN_USE: ${usedBy.join(', ')}`)
  }
  await removeKey(keyId)
}

/**
 * Proactively add a pasted `FPK1-…` key (REQ-0073 §6.3). Structure-only
 * validation (CRC) — there is no workspace challenge here. Conflict semantics:
 * - no existing entry → store (`added`);
 * - existing entry, identical key → silent no-op (refresh hint if given);
 * - existing entry, different key, `replace !== true` → `conflict` (propose);
 * - existing entry, different key, `replace === true` → overwrite (`updated`).
 * The pasted key is never persisted in any renderer/store state.
 */
export async function addKey(
  keyInput: string,
  hint?: string,
  replace?: boolean
): Promise<SecretsAddKeyResult> {
  let rawKey: Uint8Array
  try {
    rawKey = secrets.parseKey(keyInput)
  } catch {
    return { status: 'invalid-format' }
  }
  const keyId = secrets.deriveKeyId(rawKey)
  const existing = await findKeyMetadata(keyId)
  const trimmedHint = hint && hint.trim() ? hint.trim() : undefined

  if (!existing) {
    await storeWorkspaceKey(keyId, rawKey, trimmedHint)
    return { status: 'added', entry: await metadataOrThrow(keyId) }
  }

  const existingMaterial = await peekKeyMaterial(keyId)
  if (existingMaterial && bytesEqual(existingMaterial, rawKey)) {
    if (trimmedHint && trimmedHint !== existing.workspaceHint) {
      await setKeyHint(keyId, trimmedHint)
      return { status: 'noop', entry: await metadataOrThrow(keyId) }
    }
    return { status: 'noop', entry: existing }
  }

  if (!replace) return { status: 'conflict', existing }

  // Different key, same keyId, replacement confirmed: fresh entry (new createdAt).
  await removeKey(keyId)
  await storeWorkspaceKey(keyId, rawKey, trimmedHint)
  return { status: 'updated', entry: await metadataOrThrow(keyId) }
}
