/**
 * REQ-0074/0076 — Local environment value layer (`environments/<id>/.state/localvalues.json`).
 *
 * A per-machine, gitignored overlay over the shared `config.json`. Holds:
 *  - overrides of shared variables (plain) and shared secrets (encrypted), and
 *  - local-only variables (names present in no shared map; always plaintext).
 *
 * Secrecy is sticky by variable name: a value whose name is a shared *secret* is
 * stored encrypted (`enc:v1`, AD = name, same workspace key); plain and
 * local-only names are stored as plaintext (the file is machine-local).
 *
 * This module owns the single resolution merge (`mergeEnvironmentLayers`) used by
 * both the desktop adapter and the CLI — parity by construction. Decryption stays
 * lazy at the wire boundary: the merge only chooses *which* `enc:`/plaintext value
 * wins per name; `resolveSecrets` decrypts the referenced ones afterwards.
 */

import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'
import type { EnvironmentChanges, EnvWriteNotPersistedWarning } from '@shared/types'
import { isReservedVariableName } from '@shared/lib/dynamic-variables'
import { encryptValue, isEncryptedValue } from './crypto'
import { assertSafeIdentifier } from '../workspace/safe-path'
import { envFolderPath, resolveEnvFolder } from '../workspace/environments'
import { atomicWriteFile } from '../workspace/atomic-write'
import { CoreError } from '../shared/context'

const STATE_DIR = '.state'
const VALUES_FILE = 'localvalues.json'
const VALUES_VERSION = 1 as const

/** On-disk shape of the local value layer (REQ-0076: map renamed `values` → `variables`). */
export interface LocalValuesFile {
  version: typeof VALUES_VERSION
  /** Present iff any value is encrypted; the workspace key those values were written under. */
  keyId?: string
  /** Variable name → local value (plaintext, or `enc:v1:…` for secret-named entries). */
  variables: Record<string, string>
}

/**
 * Result of merging the shared layer with the local layer. `variables` and
 * `secretsMap` are what resolution/marker minting consume; the remaining arrays
 * are classification metadata the editor and the orphan/notice paths use.
 */
export interface MergedEnvironment {
  /** Plain variables: shared plain values overlaid by local plain overrides + local-only names. */
  variables: Record<string, string>
  /** Secret-shaped values (`enc:`/`null`) from shared, overlaid by *usable* local encrypted overrides. */
  secretsMap: Record<string, string | null>
  /** Names with an applied local override (plain or secret). */
  overrides: string[]
  /** Names present only in the local layer (in no shared map). */
  localOnly: string[]
  /** Secret-named local enc values under a stale keyId — fell back to shared. */
  orphans: string[]
  /** Secret-named local values that are plaintext (hand-edited) — fell back to shared. */
  invalid: string[]
}

/**
 * REQ-0076: `enc:` is a reserved value prefix — a plain value may never start with
 * it. Reused at every write surface to reject hand-typed/script fakes; the read
 * path treats any `enc:` value as ciphertext unconditionally.
 */
export const RESERVED_VALUE_PREFIX = 'enc:'

/** Whether a value is a reserved-prefix string (would be ambiguous as a plain value). */
export function isReservedPrefixValue(value: unknown): boolean {
  return isEncryptedValue(value)
}

/**
 * Whether a name is classified as a *secret* by the shared layer (REQ-0076: derived
 * from the shared value's *shape* — `null` or `enc:` — not from a separate map).
 */
export function classifyLocalWrite(
  name: string,
  sharedVariables?: Record<string, string | null>
): 'secret' | 'plain' {
  if (!sharedVariables || !Object.prototype.hasOwnProperty.call(sharedVariables, name)) {
    return 'plain'
  }
  const value = sharedVariables[name]
  return value === null || isEncryptedValue(value) ? 'secret' : 'plain'
}

/** An empty local layer (the resolution of a workspace with no `localvalues.json`). */
export function emptyLocalValues(): LocalValuesFile {
  return { version: VALUES_VERSION, variables: {} }
}

/**
 * Absolute path of an environment's local values file, keyed by **folder name**.
 * The identifier is opaque and is never a path segment; callers holding one use
 * {@link resolveLocalValuesPath}. The folder may originate from on-disk content,
 * so traversal is rejected before it reaches the filesystem (mirrors cookie-jar).
 */
export function localValuesPath(workspacePath: string, folderName: string): string {
  assertSafeIdentifier(folderName, 'environment folder')
  return join(envFolderPath(workspacePath, folderName), STATE_DIR, VALUES_FILE)
}

/**
 * Absolute path of an environment's local values file, addressed by its opaque
 * identifier (§6.10). Resolved close to the I/O, so a folder renamed mid-operation
 * surfaces as `ENVIRONMENT_NOT_FOUND` rather than a write to a stale path.
 */
export async function resolveLocalValuesPath(
  workspacePath: string,
  environmentId: string
): Promise<string> {
  return localValuesPath(workspacePath, await resolveEnvFolder(workspacePath, environmentId))
}

/**
 * Read the local value layer. Returns an empty layer when the file is missing or
 * unreadable/corrupt — local values are regenerable by nature, so a broken file
 * degrades to "no overrides" rather than throwing (resolution falls back to shared).
 */
export async function readLocalValues(
  workspacePath: string,
  environmentId: string
): Promise<LocalValuesFile> {
  let raw: string
  try {
    raw = await fs.readFile(await resolveLocalValuesPath(workspacePath, environmentId), 'utf-8')
  } catch {
    // REQ-0076: only `localvalues.json` is read. A legacy `values.json` is ignored
    // (local data is regenerable — no fallback, no error).
    return emptyLocalValues()
  }
  try {
    // `null` is invalid in the local layer (§5.2): keep only string entries on read.
    const parsed = JSON.parse(raw) as { keyId?: unknown; variables?: unknown }
    const rawMap = parsed.variables
    const variables =
      rawMap && typeof rawMap === 'object' && !Array.isArray(rawMap)
        ? (Object.fromEntries(
            Object.entries(rawMap as Record<string, unknown>).filter(
              ([, v]) => typeof v === 'string'
            )
          ) as Record<string, string>)
        : {}
    return {
      version: VALUES_VERSION,
      ...(typeof parsed.keyId === 'string' && parsed.keyId ? { keyId: parsed.keyId } : {}),
      variables
    }
  } catch {
    return emptyLocalValues()
  }
}

/**
 * Atomically write the local value layer (temp + rename). When `variables` is empty
 * the file is unlinked instead of left as a stale `{ "variables": {} }` (mirrors the
 * cookie-jar cleanup, and keeps the "no file ⇒ byte-identical resolution"
 * invariant intact once the last override is cleared).
 */
export async function writeLocalValues(
  workspacePath: string,
  environmentId: string,
  file: LocalValuesFile
): Promise<void> {
  const filePath = await resolveLocalValuesPath(workspacePath, environmentId)
  if (Object.keys(file.variables).length === 0) {
    await fs.unlink(filePath).catch(() => undefined)
    return
  }
  // `keyId` is only meaningful when something is encrypted; drop it otherwise so
  // a file with no secret overrides never claims a key.
  const hasEncrypted = Object.values(file.variables).some(isEncryptedValue)
  const out: LocalValuesFile = {
    version: VALUES_VERSION,
    ...(hasEncrypted && file.keyId ? { keyId: file.keyId } : {}),
    variables: file.variables
  }
  await atomicWriteFile(filePath, `${JSON.stringify(out, null, 2)}\n`)
}

/**
 * SEC-03 — serializes every read-modify-write of one environment's
 * `localvalues.json` (in this process). Two sends finishing together each read
 * the file, and the later atomic rename silently dropped the other's script
 * write; inside the lock each writer re-reads the latest file. Keyed by the
 * resolved workspace path and the opaque environment identifier (the folder is
 * resolved inside, close to the I/O).
 *
 * Not reentrant: a locked function never calls another locked one. Lock order
 * is workspace key (setup/rotate) → local values → keystore; nothing taken
 * inside this lock reaches back for the workspace-key lock.
 */
const localValuesLocks = new Map<string, Promise<void>>()

export async function withLocalValuesLock<T>(
  workspacePath: string,
  environmentId: string,
  fn: () => Promise<T>
): Promise<T> {
  const key = `${resolve(workspacePath)}\u0000${environmentId}`
  const run = (localValuesLocks.get(key) ?? Promise.resolve()).then(fn)
  const tail = run.then(
    () => undefined,
    () => undefined
  )
  localValuesLocks.set(key, tail)
  try {
    return await run
  } finally {
    if (localValuesLocks.get(key) === tail) localValuesLocks.delete(key)
  }
}

export interface PersistScriptEnvChangesInput {
  workspacePath: string
  environmentId: string
  changes: EnvironmentChanges | undefined
  /** The shared `config.json` variables — the classification source (sticky secrecy). */
  sharedVariables: Record<string, string | null>
  /** The workspace manifest's current keyId (`undefined` when the workspace has no secrets). */
  currentKeyId: string | undefined
  /**
   * Lazy provider of the current workspace key. Called at most once, and only
   * when a secret-named write actually has to be encrypted. Key custody stays
   * with the adapter (desktop key store / `FETCHPIER_WORKSPACE_KEY`).
   */
  getKey: () => Promise<Uint8Array | null>
}

/**
 * Persist script-written environment changes into the environment's local value
 * layer. The single writer for script writes, shared by the desktop (always) and
 * the CLI (`--persist-env`): the core owns what a workspace contains.
 *
 * Rules (unchanged from the desktop's former writer): the shared `config.json` is
 * never written; a name that is a shared *secret* is stored encrypted under the
 * current workspace key (sticky secrecy); plain and local-only names are stored in
 * clear; a reserved `$` name and a plain value claiming the `enc:` prefix are
 * rejected with a contractual error.
 *
 * A write that cannot be persisted does **not** fail — the send already happened
 * and the caller keeps using the value in memory. It is reported instead:
 *  - `KEY_MISSING`: a secret-named write and no workspace key is available;
 *  - `LOCAL_KEY_MISMATCH`: the file holds entries encrypted under a different
 *    (older) key. Writing a secret would have to move the file's single `keyId`
 *    and make those entries unreadable for good, so secret writes are skipped and
 *    the file's existing entries and `keyId` are left untouched. Plain writes and
 *    removals still apply — they do not depend on the key.
 */
export async function persistScriptEnvChanges(
  input: PersistScriptEnvChangesInput
): Promise<EnvWriteNotPersistedWarning[]> {
  const { workspacePath, environmentId, changes } = input
  if (!changes) return []
  const setEntries = Object.entries(changes.set)
  if (setEntries.length === 0 && changes.removed.length === 0) return []

  // SEC-03: the whole read-modify-write runs under the file's lock.
  return withLocalValuesLock(workspacePath, environmentId, () =>
    persistLocked(input, setEntries, changes.removed)
  )
}

async function persistLocked(
  input: PersistScriptEnvChangesInput,
  setEntries: Array<[string, string]>,
  removed: readonly string[]
): Promise<EnvWriteNotPersistedWarning[]> {
  const { workspacePath, environmentId, sharedVariables, currentKeyId, getKey } = input
  const local = await readLocalValues(workspacePath, environmentId)
  const hasEncrypted = Object.values(local.variables).some(isEncryptedValue)
  const keyMismatch = hasEncrypted && local.keyId !== undefined && local.keyId !== currentKeyId

  const next: Record<string, string> = { ...local.variables }
  const warnings: EnvWriteNotPersistedWarning[] = []
  let keyId = keyMismatch ? local.keyId : (local.keyId ?? currentKeyId)
  let cachedKey: Uint8Array | null | undefined
  const key = async (): Promise<Uint8Array | null> => {
    if (cachedKey === undefined) cachedKey = await getKey()
    return cachedKey
  }

  for (const [name, value] of setEntries) {
    // REQ-0087: the `$` prefix is the reserved system dynamic-variable namespace.
    if (isReservedVariableName(name)) {
      throw new CoreError(
        'RESERVED_VARIABLE_NAME',
        `Variable name "${name}" begins with "$", which is reserved for system dynamic variables.`,
        { environmentId, variable: name }
      )
    }
    if (classifyLocalWrite(name, sharedVariables) === 'secret') {
      if (keyMismatch) {
        warnings.push({ code: 'ENV_WRITE_NOT_PERSISTED', name, reason: 'LOCAL_KEY_MISMATCH' })
        continue
      }
      const k = currentKeyId ? await key() : null
      if (!currentKeyId || !k) {
        warnings.push({ code: 'ENV_WRITE_NOT_PERSISTED', name, reason: 'KEY_MISSING' })
        continue
      }
      next[name] = await encryptValue(k, name, value)
      keyId = currentKeyId
    } else {
      // REQ-0076: a plain write may not claim the reserved `enc:` prefix.
      if (isReservedPrefixValue(value)) {
        throw new CoreError(
          'WORKSPACE_INVALID',
          `Value for "${name}" starts with "enc:", which is reserved for encrypted secrets.`,
          { environmentId, variable: name }
        )
      }
      next[name] = value
    }
  }
  for (const name of removed) delete next[name]

  await writeLocalValues(workspacePath, environmentId, {
    version: VALUES_VERSION,
    ...(keyId ? { keyId } : {}),
    variables: next
  })
  return warnings
}

/**
 * Merge the shared and local layers into the resolved view, rightmost wins per
 * name. Pure — no decryption, no I/O. `currentKeyId` is the workspace manifest's
 * keyId (`undefined` when the workspace has no secrets manifest).
 *
 * Classification per local name `n` with value `v`:
 *  - `n` is a shared **secret**: `v` must be `enc:`. If `enc:` and the file's
 *    `keyId` matches `currentKeyId` → apply (override). If `enc:` but the keyId
 *    differs → **orphan** (fall back to shared; a rotation happened elsewhere and
 *    the desktop will re-wrap, the CLI runs read-only). If plaintext (hand-edited)
 *    → **invalid** (fall back to shared).
 *  - `n` is a shared **plain** variable: override the plain value.
 *  - `n` is in neither shared map: **local-only** plaintext variable.
 */
export function mergeEnvironmentLayers(
  shared: { variables?: Record<string, string | null> },
  local: LocalValuesFile,
  currentKeyId: string | undefined
): MergedEnvironment {
  // REQ-0076: split the unified shared map by value shape — plain strings feed the
  // `variables` (interpolation) map; `enc:`/`null` feed the `secretsMap` (wire).
  const variables: Record<string, string> = {}
  const secretsMap: Record<string, string | null> = {}
  for (const [name, value] of Object.entries(shared.variables ?? {})) {
    if (value === null || isEncryptedValue(value)) secretsMap[name] = value
    else variables[name] = value
  }
  const overrides: string[] = []
  const localOnly: string[] = []
  const orphans: string[] = []
  const invalid: string[] = []

  const sharedHas = (n: string): boolean =>
    !!shared.variables && Object.prototype.hasOwnProperty.call(shared.variables, n)
  const isSharedSecret = (n: string): boolean =>
    sharedHas(n) && (shared.variables![n] === null || isEncryptedValue(shared.variables![n]))
  const isSharedPlain = (n: string): boolean => sharedHas(n) && !isSharedSecret(n)

  for (const [name, value] of Object.entries(local.variables)) {
    if (isSharedSecret(name)) {
      if (!isEncryptedValue(value)) {
        // Plaintext value for a secret name — reject this override (§5.1, CA-11).
        invalid.push(name)
        continue
      }
      if (local.keyId !== undefined && local.keyId === currentKeyId) {
        secretsMap[name] = value
        overrides.push(name)
      } else {
        // Stale keyId (or no current manifest) — orphan, resolve from shared.
        orphans.push(name)
      }
      continue
    }
    if (isSharedPlain(name)) {
      variables[name] = value
      overrides.push(name)
      continue
    }
    // Local-only: a name in no shared map. Always plaintext.
    variables[name] = value
    localOnly.push(name)
  }

  return { variables, secretsMap, overrides, localOnly, orphans, invalid }
}
