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
 * The master key, cached as a promise so concurrent first uses share one load —
 * caching the value let two callers both miss and generate two master keys, the
 * second one stranding every entry wrapped by the first. A failed load is not
 * cached, so the next call retries.
 */
let masterPromise: Promise<Uint8Array> | null = null

/**
 * Load (or lazily generate) the machine-local master key. Generating a fresh
 * one resets the keystore — the previous entries are no longer decryptable.
 */
function loadMasterKey(): Promise<Uint8Array> {
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
  try {
    const enc = await fs.readFile(masterKeyPath())
    const b64 = safeStorage.decryptString(enc)
    const raw = Buffer.from(b64, 'base64')
    if (raw.length === secrets.KEY_BYTES) return new Uint8Array(raw)
  } catch {
    // Missing or undecryptable — generate a new master and reset the keystore.
  }
  const raw = new Uint8Array(randomBytes(secrets.KEY_BYTES))
  const enc = safeStorage.encryptString(Buffer.from(raw).toString('base64'))
  await workspace.atomicWriteFile(masterKeyPath(), enc)
  await workspace.atomicWriteFile(keystorePath(), JSON.stringify({ version: 1, keys: {} }, null, 2))
  return raw
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

async function readKeystoreFile(): Promise<KeystoreFile> {
  try {
    const raw = await fs.readFile(keystorePath(), 'utf-8')
    const parsed = JSON.parse(raw) as KeystoreFile
    if (parsed && typeof parsed === 'object' && parsed.keys && typeof parsed.keys === 'object') {
      return { version: 1, keys: parsed.keys }
    }
  } catch {
    // Missing or corrupt — treat as empty (§7.2).
  }
  return { version: 1, keys: {} }
}

async function getStoredKey(keyId: string): Promise<Uint8Array | null> {
  const file = await readKeystoreFile()
  const entry = file.keys[keyId]
  if (!entry) return null
  try {
    const master = await loadMasterKey()
    const b64 = await secrets.decryptValue(master, keyId, entry.key)
    const raw = Buffer.from(b64, 'base64')
    if (raw.length !== secrets.KEY_BYTES) return null
    await touchLastUsed(entry, keyId)
    return new Uint8Array(raw)
  } catch {
    return null
  }
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
  const master = await loadMasterKey()
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
 * persistent backend) the keystore. Returns null when locked / not stored.
 */
export async function getWorkspaceKey(keyId: string): Promise<Uint8Array | null> {
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
  if (!entry) return null
  try {
    const master = await loadMasterKey()
    const b64 = await secrets.decryptValue(master, keyId, entry.key)
    const raw = Buffer.from(b64, 'base64')
    if (raw.length !== secrets.KEY_BYTES) return null
    return new Uint8Array(raw)
  } catch {
    return null
  }
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
