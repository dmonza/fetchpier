/**
 * REQ-0070 — user keystore: persistence on os-keychain, no persistence under
 * the Linux `basic_text` fallback, and keyId-indexed sharing across "checkouts".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let userDataDir: string
let backend = 'kwallet' // os-keychain by default

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => backend,
    encryptString: (s: string) => Buffer.from(`sealed:${s}`, 'utf-8'),
    decryptString: (b: Buffer) => b.toString('utf-8').replace(/^sealed:/, '')
  }
}))

import { getWorkspaceKey, storeWorkspaceKey } from './keystore'
import { lockAll } from './unlock-state'
import { secrets } from '@fetchpier/core'

const { generateWorkspaceKey, deriveKeyId } = secrets

beforeEach(async () => {
  userDataDir = await fs.mkdtemp(join(tmpdir(), 'fp-keystore-'))
  backend = 'kwallet'
  lockAll()
})
afterEach(async () => {
  lockAll()
  await fs.rm(userDataDir, { recursive: true, force: true })
})

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

interface StoredEntry {
  key: string
  createdAt: string
  lastUsedAt?: string
  workspaceHint?: string
}

async function readKeystore(): Promise<{ version: number; keys: Record<string, StoredEntry> }> {
  const raw = await fs.readFile(join(userDataDir, 'secrets', 'keystore.json'), 'utf-8')
  return JSON.parse(raw)
}

async function writeLastUsed(keyId: string, value: string): Promise<void> {
  const store = await readKeystore()
  store.keys[keyId].lastUsedAt = value
  await fs.writeFile(join(userDataDir, 'secrets', 'keystore.json'), JSON.stringify(store, null, 2))
}

describe('keystore (os-keychain backend)', () => {
  it('persists a key and recovers it after a simulated restart (lockAll)', async () => {
    const key = await generateWorkspaceKey()
    const keyId = deriveKeyId(key)
    await storeWorkspaceKey(keyId, key, 'my-ws')

    expect(await exists(join(userDataDir, 'secrets', 'master.key'))).toBe(true)
    expect(await exists(join(userDataDir, 'secrets', 'keystore.json'))).toBe(true)

    // Simulate a new session: in-memory keys cleared, keystore re-read.
    lockAll()
    const recovered = await getWorkspaceKey(keyId)
    expect(recovered).not.toBeNull()
    expect(Buffer.from(recovered!).equals(Buffer.from(key))).toBe(true)
  })

  it('shares one entry across checkouts with the same keyId', async () => {
    const key = await generateWorkspaceKey()
    const keyId = deriveKeyId(key)
    await storeWorkspaceKey(keyId, key, 'checkout-a')
    lockAll()
    // A second checkout (same repo → same keyId) resolves the same stored key.
    const fromOtherCheckout = await getWorkspaceKey(keyId)
    expect(fromOtherCheckout).not.toBeNull()
    expect(Buffer.from(fromOtherCheckout!).equals(Buffer.from(key))).toBe(true)
  })

  it('sets lastUsedAt to createdAt on creation', async () => {
    const key = await generateWorkspaceKey()
    const keyId = deriveKeyId(key)
    await storeWorkspaceKey(keyId, key, 'my-ws')

    const store = await readKeystore()
    const entry = store.keys[keyId]
    expect(entry.lastUsedAt).toBe(entry.createdAt)
  })

  it('refreshes lastUsedAt on get only when older than the 24h debounce', async () => {
    const key = await generateWorkspaceKey()
    const keyId = deriveKeyId(key)
    await storeWorkspaceKey(keyId, key)

    // A recent get (just stored) must not rewrite the timestamp.
    lockAll()
    const created = (await readKeystore()).keys[keyId].lastUsedAt
    await getWorkspaceKey(keyId)
    expect((await readKeystore()).keys[keyId].lastUsedAt).toBe(created)

    // Force the stored timestamp >24h into the past, then get → it advances.
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
    await writeLastUsed(keyId, stale)
    lockAll()
    await getWorkspaceKey(keyId)
    const refreshed = (await readKeystore()).keys[keyId].lastUsedAt!
    expect(Date.parse(refreshed)).toBeGreaterThan(Date.parse(stale))
  })

  it('returns the key even when the lastUsedAt refresh write fails, keystore.json left intact (CA-02)', async () => {
    const key = await generateWorkspaceKey()
    const keyId = deriveKeyId(key)
    await storeWorkspaceKey(keyId, key)
    await writeLastUsed(keyId, new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString())
    lockAll()
    const before = await readKeystore()

    // A failing keystore rewrite must not break the unlock path (best-effort).
    const spy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('EROFS'))
    const recovered = await getWorkspaceKey(keyId)
    spy.mockRestore()
    expect(recovered).not.toBeNull()
    expect(Buffer.from(recovered!).equals(Buffer.from(key))).toBe(true)
    // The interrupted rewrite must not corrupt/truncate the on-disk keystore —
    // the touch is silently skipped, the previous file survives untouched.
    expect(await readKeystore()).toEqual(before)
  })

  // Atomic writes — closing the write-safety coverage gap: this module used to
  // hand-roll its own temp+rename (missing the shared helper's Windows retry).
  it('retries the rename through a transient error and eventually succeeds (CA-01)', async () => {
    const key = await generateWorkspaceKey()
    const keyId = deriveKeyId(key)
    const transient = Object.assign(new Error('EPERM: operation not permitted, rename'), {
      code: 'EPERM'
    })
    const renameSpy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(transient)

    await storeWorkspaceKey(keyId, key, 'my-ws')

    expect(renameSpy).toHaveBeenCalled()
    renameSpy.mockRestore()
    lockAll()
    const recovered = await getWorkspaceKey(keyId)
    expect(recovered).not.toBeNull()
    expect(Buffer.from(recovered!).equals(Buffer.from(key))).toBe(true)
  })

  it('overwrites cleanly on a second store (atomic write leaves a valid file)', async () => {
    const k1 = await generateWorkspaceKey()
    const id1 = deriveKeyId(k1)
    await storeWorkspaceKey(id1, k1)
    const k2 = await generateWorkspaceKey()
    const id2 = deriveKeyId(k2)
    await storeWorkspaceKey(id2, k2)
    lockAll()
    expect(Buffer.from((await getWorkspaceKey(id1))!).equals(Buffer.from(k1))).toBe(true)
    expect(Buffer.from((await getWorkspaceKey(id2))!).equals(Buffer.from(k2))).toBe(true)
  })
})

describe('keystore (session-only / basic_text)', () => {
  it('holds the key in memory but writes nothing under userData', async () => {
    backend = 'basic_text'
    const key = await generateWorkspaceKey()
    const keyId = deriveKeyId(key)
    await storeWorkspaceKey(keyId, key, 'ws')

    // In-session it is available...
    expect(await getWorkspaceKey(keyId)).not.toBeNull()
    // ...but nothing was persisted.
    expect(await exists(join(userDataDir, 'secrets', 'keystore.json'))).toBe(false)
    expect(await exists(join(userDataDir, 'secrets', 'master.key'))).toBe(false)

    // After a restart the key is gone (must be re-entered).
    lockAll()
    expect(await getWorkspaceKey(keyId)).toBeNull()
  })
})
