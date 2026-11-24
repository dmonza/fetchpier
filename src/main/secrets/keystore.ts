/**
 * REQ-0070 §5.2/§6.5 — machine-local user keystore (`<userData>/secrets/`).
 *
 *   master.key     — 32-byte master key, encrypted via Electron `safeStorage`.
 *   keystore.json  — workspace keys wrapped by the master key (AEAD, AD = keyId),
 *                    indexed by **keyId** (key identity, never workspace path).
 *
 * Indexing by keyId means two checkouts of the same repository share one entry
 * (enter once, unlocked everywhere) and a rotation's old+new keys coexist.
 *
 * Both files are written atomically (temp + rename), and every rewrite of
 * `keystore.json` is serialized (`withKeystoreLock`). An undecryptable master
 * key (keychain reset, new machine) is recoverable: the keystore is treated as
 * empty and rebuilt as workspace keys are re-entered (§7.2).
 *
 * ISS-0205 — only two cases count as "nothing to read": a file that does not
 * exist (`ENOENT`), and a master key read in full that no longer decrypts. Any
 * other read error, or a `keystore.json` that does not parse, is a
 * {@link KeystoreUnreadableError}: write paths fail with it and write nothing;
 * read paths report "no key". The reset itself runs only on a write path, and
 * first sets the previous files aside (`<name>.<timestamp>.bak`, same folder)
 * instead of overwriting them.
 */

import { app, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { secrets, workspace } from '@fetchpier/core'
import type { WorkspaceKeyMetadata } from '../../shared/types'
import { detectBackend } from './backend'
import { forgetKey, getLiveKey, rememberKey } from './unlock-state'

interface KeystoreEntry {
  key: string
  createdAt: string
  lastUsedAt?: string
  workspaceHint?: string
}
interface KeystoreFile {
  version: number
  keys: Record<string, KeystoreEntry>
}

/**
 * REQ-0073 §6.4 — metadata for the session-only backend, where keys live only in
 * memory (never written to `keystore.json`). Mirrors the persisted entry's
 * metadata so the Workspace keys tab can list degraded-mode entries too.
 */
interface SessionKeyMeta {
  createdAt: string
  lastUsedAt: string
  workspaceHint?: string
}
const sessionMeta = new Map<string, SessionKeyMeta>()

/**
 * `lastUsedAt` is refreshed on every `get`, but the file is only rewritten when
 * the stored timestamp is older than this — keeping the keystore effectively
 * read-only in steady use (REQ-0072 §5.2). The refresh is best-effort: a failed
 * write is swallowed and never blocks or fails the unlock path.
 */
const LAST_USED_DEBOUNCE_MS = 24 * 60 * 60 * 1000

function secretsDir(): string {
  return join(app.getPath('userData'), 'secrets')
}
function masterKeyPath(): string {
  return join(secretsDir(), 'master.key')
}
function keystorePath(): string {
  return join(secretsDir(), 'keystore.json')
}

/**
 * ISS-0205 — the keystore exists but cannot be read right now (an I/O or
 * permission error, a file another program holds, a `keystore.json` that does
 * not parse). Distinct from "no key stored": nothing is reset or rewritten.
 */
export class KeystoreUnreadableError extends Error {
  readonly code = 'KEYSTORE_UNREADABLE'
  constructor(
    readonly file: 'master.key' | 'keystore.json',
    options?: { cause?: unknown }
  ) {
    super(
      `The machine keystore (${file}) could not be read. Nothing was changed; try again.`,
      options
    )
    this.name = 'KeystoreUnreadableError'
  }
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * The master key, cached as a promise so concurrent first uses share one load —
 * caching the value let two callers both miss and generate two master keys, the
 * second one stranding every entry wrapped by the first. A failed load is not
 * cached, so the next call retries.
 */
let masterPromise: Promise<Uint8Array> | null = null

/**
 * Read `master.key` without ever writing. `missing` and `undecryptable` are the
 * two states a reset may follow; any other read error throws.
 */
async function readMasterKey(): Promise<Uint8Array | 'missing' | 'undecryptable'> {
  let enc: Buffer
  try {
    enc = await fs.readFile(masterKeyPath())
  } catch (err) {
    if (isMissing(err)) return 'missing'
    throw new KeystoreUnreadableError('master.key', { cause: err })
  }
  try {
    const raw = Buffer.from(safeStorage.decryptString(enc), 'base64')
    if (raw.length === secrets.KEY_BYTES) return new Uint8Array(raw)
  } catch {
    // Read in full but not decryptable (keychain reset, new machine).
  }
  return 'undecryptable'
}

/**
 * Read path: the cached or on-disk master key, or null when there is none that
 * opens (missing or undecryptable). Never generates and never writes.
 */
async function loadExistingMasterKey(): Promise<Uint8Array | null> {
  if (masterPromise) return masterPromise
  const found = await readMasterKey()
  if (!(found instanceof Uint8Array)) return null
  masterPromise ??= Promise.resolve(found)
  return masterPromise
}

/**
 * Write path: load the master key, or generate one when there is none that
 * opens. Generating resets the keystore — the previous entries are no longer
 * decryptable — so the old files are set aside first.
 */
function loadOrCreateMasterKey(): Promise<Uint8Array> {
  if (!masterPromise) {
    masterPromise = readOrCreateMasterKey().catch((err: unknown) => {
      masterPromise = null
      throw err
    })
  }
  return masterPromise
}

async function readOrCreateMasterKey(): Promise<Uint8Array> {
  await fs.mkdir(secretsDir(), { recursive: true })
  const found = await readMasterKey()
  if (found instanceof Uint8Array) return found
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const raw = new Uint8Array(randomBytes(secrets.KEY_BYTES))
  const enc = safeStorage.encryptString(Buffer.from(raw).toString('base64'))
  await withKeystoreLock(async () => {
    // Set aside before writing: a failed rename aborts the reset with nothing overwritten.
    if (found === 'undecryptable') await setAside(masterKeyPath(), stamp)
    await setAside(keystorePath(), stamp)
    await workspace.atomicWriteFile(masterKeyPath(), enc)
    await workspace.atomicWriteFile(keystorePath(), JSON.stringify(emptyKeystore(), null, 2))
  })
  return raw
}

/** Rename `path` to `<path>.<stamp>.bak` in the same folder; a missing file is a no-op. */
async function setAside(path: string, stamp: string): Promise<void> {
  try {
    await fs.rename(path, `${path}.${stamp}.bak`)
  } catch (err) {
    if (!isMissing(err)) throw err
  }
}

function emptyKeystore(): KeystoreFile {
  return { version: 1, keys: {} }
}

/**
 * Serializes every read-modify-write of `keystore.json`. Each writer re-reads
 * the file inside the lock, so two concurrent stores (a double click on the
 * first secret) both land instead of the later write dropping the other entry.
 */
let keystoreQueue: Promise<unknown> = Promise.resolve()

function withKeystoreLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = keystoreQueue.then(fn, fn)
  keystoreQueue = run.catch(() => undefined)
  return run
}

/**
 * `keystore.json`, or an empty map when it does not exist. An unreadable or
 * unparseable file throws {@link KeystoreUnreadableError}: a write built on an
 * empty map would drop every entry the file holds (ISS-0205).
 */
async function readKeystoreFile(): Promise<KeystoreFile> {
  let raw: string
  try {
    raw = await fs.readFile(keystorePath(), 'utf-8')
  } catch (err) {
    if (isMissing(err)) return emptyKeystore()
    throw new KeystoreUnreadableError('keystore.json', { cause: err })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new KeystoreUnreadableError('keystore.json', { cause: err })
  }
  const keys = (parsed as Partial<KeystoreFile> | null)?.keys
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) {
    throw new KeystoreUnreadableError('keystore.json')
  }
  return { version: 1, keys }
}

/** Unwrap an entry with the existing master key; null when it does not open. */
async function unwrapEntry(keyId: string, entry: KeystoreEntry): Promise<Uint8Array | null> {
  const master = await loadExistingMasterKey()
  if (!master) return null
  try {
    const b64 = await secrets.decryptValue(master, keyId, entry.key)
    const raw = Buffer.from(b64, 'base64')
    return raw.length === secrets.KEY_BYTES ? new Uint8Array(raw) : null
  } catch {
    return null
  }
}

async function getStoredKey(keyId: string): Promise<Uint8Array | null> {
  const file = await readKeystoreFile()
  const entry = file.keys[keyId]
  if (!entry) return null
  const key = await unwrapEntry(keyId, entry)
  if (key) await touchLastUsed(entry, keyId)
  return key
}

/**
 * Debounced, best-effort refresh of an entry's `lastUsedAt` (REQ-0072 §5.2).
 * Only rewrites the keystore when the stored timestamp is missing or older than
 * {@link LAST_USED_DEBOUNCE_MS}. Any failure is swallowed — this must never
 * block or fail the unlock path.
 */
async function touchLastUsed(read: KeystoreEntry, keyId: string): Promise<void> {
  try {
    const previous = read.lastUsedAt ? Date.parse(read.lastUsedAt) : NaN
    const now = Date.now()
    if (Number.isFinite(previous) && now - previous < LAST_USED_DEBOUNCE_MS) return
    await withKeystoreLock(async () => {
      // Re-read inside the lock: the rewrite must not drop an entry stored since.
      const file = await readKeystoreFile()
      const entry = file.keys[keyId]
      if (!entry) return
      entry.lastUsedAt = new Date(now).toISOString()
      await workspace.atomicWriteFile(keystorePath(), JSON.stringify(file, null, 2))
    })
  } catch {
    // Best-effort metadata; never affects the returned key.
  }
}

async function putStoredKey(
  keyId: string,
  rawKey: Uint8Array,
  workspaceHint?: string
): Promise<void> {
  const master = await loadOrCreateMasterKey()
  const keyB64 = Buffer.from(rawKey).toString('base64')
  const wrapped = await secrets.encryptValue(master, keyId, keyB64)
  await withKeystoreLock(async () => {
    const file = await readKeystoreFile()
    const createdAt = file.keys[keyId]?.createdAt ?? new Date().toISOString()
    file.keys[keyId] = {
      key: wrapped,
      createdAt,
      // On creation `lastUsedAt` mirrors `createdAt` — storing a key is itself a
      // real use (REQ-0072 §5.2). Preserve a later value across re-stores.
      lastUsedAt: file.keys[keyId]?.lastUsedAt ?? createdAt,
      ...(workspaceHint ? { workspaceHint } : {})
    }
    await workspace.atomicWriteFile(keystorePath(), JSON.stringify(file, null, 2))
  })
}

/**
 * Resolve the live workspace key for a keyId: in-memory first, then (on the
 * persistent backend) the keystore. Returns null when locked / not stored, and
 * throws {@link KeystoreUnreadableError} when the keystore cannot be read — the
 * secrets status uses it to tell the two apart.
 */
export async function resolveWorkspaceKey(keyId: string): Promise<Uint8Array | null> {
  const live = getLiveKey(keyId)
  if (live) return live
  if (detectBackend() === 'os-keychain') {
    const stored = await getStoredKey(keyId)
    if (stored) {
      rememberKey(keyId, stored)
      return stored
    }
  }
  return null
}

/**
 * {@link resolveWorkspaceKey} for the callers that only need "is there a key":
 * an unreadable keystore reads as locked (null), and nothing is written.
 */
export async function getWorkspaceKey(keyId: string): Promise<Uint8Array | null> {
  try {
    return await resolveWorkspaceKey(keyId)
  } catch (err) {
    if (err instanceof KeystoreUnreadableError) return null
    throw err
  }
}

/**
 * Persist + cache a freshly entered/generated workspace key. On the session-only
 * backend it is held in memory only (never written under ineffective encryption).
 */
export async function storeWorkspaceKey(
  keyId: string,
  rawKey: Uint8Array,
  workspaceHint?: string
): Promise<void> {
  rememberKey(keyId, rawKey)
  if (detectBackend() === 'os-keychain') {
    await putStoredKey(keyId, rawKey, workspaceHint)
  } else {
    rememberSessionMeta(keyId, workspaceHint)
  }
}

// ── REQ-0073: keystore management primitives (list / delete / add) ────────────

/** Map a persisted entry to its surface metadata (never the wrapped key). */
function persistedMetadata(keyId: string, entry: KeystoreEntry): WorkspaceKeyMetadata {
  return {
    keyId,
    createdAt: entry.createdAt,
    lastUsedAt: entry.lastUsedAt ?? entry.createdAt,
    backing: 'os-keychain',
    ...(entry.workspaceHint ? { workspaceHint: entry.workspaceHint } : {})
  }
}

/** Record/refresh the in-memory metadata for a session-only key. */
function rememberSessionMeta(keyId: string, workspaceHint?: string): void {
  const now = new Date().toISOString()
  const existing = sessionMeta.get(keyId)
  sessionMeta.set(keyId, {
    createdAt: existing?.createdAt ?? now,
    lastUsedAt: now,
    workspaceHint: workspaceHint ?? existing?.workspaceHint
  })
}

function sessionMetadata(keyId: string, meta: SessionKeyMeta): WorkspaceKeyMetadata {
  return {
    keyId,
    createdAt: meta.createdAt,
    lastUsedAt: meta.lastUsedAt,
    backing: 'session-only',
    ...(meta.workspaceHint ? { workspaceHint: meta.workspaceHint } : {})
  }
}

/**
 * List every keystore entry as metadata only — persisted entries (read straight
 * from `keystore.json`, no unwrap, never a keychain prompt) merged with
 * session-only entries. Persisted entries win on a keyId collision.
 */
export async function listKeyEntries(): Promise<WorkspaceKeyMetadata[]> {
  const file = await readKeystoreFile()
  const out: WorkspaceKeyMetadata[] = []
  const seen = new Set<string>()
  for (const [keyId, entry] of Object.entries(file.keys)) {
    out.push(persistedMetadata(keyId, entry))
    seen.add(keyId)
  }
  for (const [keyId, meta] of sessionMeta) {
    if (seen.has(keyId)) continue
    out.push(sessionMetadata(keyId, meta))
  }
  return out
}

/** Look up one entry's metadata (persisted first, then session-only). */
export async function findKeyMetadata(keyId: string): Promise<WorkspaceKeyMetadata | null> {
  const file = await readKeystoreFile()
  const entry = file.keys[keyId]
  if (entry) return persistedMetadata(keyId, entry)
  const meta = sessionMeta.get(keyId)
  return meta ? sessionMetadata(keyId, meta) : null
}

/**
 * Resolve a stored key's raw material without touching `lastUsedAt` — used only
 * to compare against a re-pasted key on add. Live key first, then unwrap.
 */
export async function peekKeyMaterial(keyId: string): Promise<Uint8Array | null> {
  const live = getLiveKey(keyId)
  if (live) return live
  const file = await readKeystoreFile()
  const entry = file.keys[keyId]
  return entry ? unwrapEntry(keyId, entry) : null
}

/** Update just the display hint of an existing entry (persisted and/or session). */
export async function setKeyHint(keyId: string, workspaceHint: string): Promise<void> {
  await withKeystoreLock(async () => {
    const file = await readKeystoreFile()
    const entry = file.keys[keyId]
    if (entry) {
      entry.workspaceHint = workspaceHint
      await workspace.atomicWriteFile(keystorePath(), JSON.stringify(file, null, 2))
    }
  })
  const meta = sessionMeta.get(keyId)
  if (meta) meta.workspaceHint = workspaceHint
}

/**
 * Remove a key from the machine: persisted entry (atomic rewrite), session
 * metadata, and the live cache. Never touches any workspace file (REQ-0073 §6.2).
 */
export async function removeKey(keyId: string): Promise<void> {
  await withKeystoreLock(async () => {
    const file = await readKeystoreFile()
    if (file.keys[keyId]) {
      delete file.keys[keyId]
      await workspace.atomicWriteFile(keystorePath(), JSON.stringify(file, null, 2))
    }
  })
  sessionMeta.delete(keyId)
  forgetKey(keyId)
}

/** Test/lifecycle hook: drop all session-only metadata (mirrors `lockAll`). */
export function clearSessionMeta(): void {
  sessionMeta.clear()
}
