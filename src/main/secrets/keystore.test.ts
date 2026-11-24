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
/** How many upcoming `decryptString` calls throw (the OS credential store refusing). */
let decryptFailures = 0

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => backend,
    encryptString: (s: string) => Buffer.from(`sealed:${s}`, 'utf-8'),
    decryptString: (b: Buffer) => {
      if (decryptFailures > 0) {
        decryptFailures--
        throw new Error(
          'Error while decrypting the ciphertext provided to safeStorage.decryptString.'
        )
      }
      return b.toString('utf-8').replace(/^sealed:/, '')
    }
  }
}))

import { getWorkspaceKey, storeWorkspaceKey } from './keystore'
import { lockAll } from './unlock-state'
import { secrets } from '@fetchpier/core'

const { generateWorkspaceKey, deriveKeyId } = secrets

beforeEach(async () => {
  userDataDir = await fs.mkdtemp(join(tmpdir(), 'fp-keystore-'))
  backend = 'kwallet'
  decryptFailures = 0
  lockAll()
})
afterEach(async () => {
  vi.restoreAllMocks()
  decryptFailures = 0
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

  // SEC-06: two stores at once on a machine's first use. Unserialized, both
  // generated a master key and each rewrote keystore.json from a stale read, so
  // one entry was lost or wrapped by a master key no longer on disk.
  it('keeps both entries when two keys are stored concurrently on first use', async () => {
    // A fresh module: no master key cached from an earlier test.
    vi.resetModules()
    const fresh = await import('./keystore')
    const k1 = await generateWorkspaceKey()
    const k2 = await generateWorkspaceKey()
    await Promise.all([
      fresh.storeWorkspaceKey(deriveKeyId(k1), k1, 'one'),
      fresh.storeWorkspaceKey(deriveKeyId(k2), k2, 'two')
    ])
    expect(Object.keys((await readKeystore()).keys).sort()).toEqual(
      [deriveKeyId(k1), deriveKeyId(k2)].sort()
    )
    // A restart (new module, nothing live) unwraps both with the master key on disk.
    vi.resetModules()
    const restarted = await import('./keystore')
    const r1 = await restarted.getWorkspaceKey(deriveKeyId(k1))
    const r2 = await restarted.getWorkspaceKey(deriveKeyId(k2))
    expect(r1 && Buffer.from(r1).equals(Buffer.from(k1))).toBe(true)
    expect(r2 && Buffer.from(r2).equals(Buffer.from(k2))).toBe(true)
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

// ISS-0205: a read failure that is not "the file does not exist" must never be
// taken for an empty keystore — it used to regenerate master.key and rewrite
// keystore.json, discarding every stored workspace key.
describe('keystore read failures (ISS-0205)', () => {
  const secretsPath = (name: string): string => join(userDataDir, 'secrets', name)

  async function snapshot(): Promise<{ master: string; keystore: string }> {
    return {
      master: (await fs.readFile(secretsPath('master.key'))).toString('base64'),
      keystore: await fs.readFile(secretsPath('keystore.json'), 'utf-8')
    }
  }

  /** Make the next `fs.readFile` of `file` reject with `code`, once. */
  function failNextRead(file: string, code = 'EBUSY'): void {
    const original = fs.readFile.bind(fs) as (...args: unknown[]) => Promise<unknown>
    let failed = false
    vi.spyOn(fs, 'readFile').mockImplementation(((...args: unknown[]) => {
      if (!failed && String(args[0]).endsWith(file)) {
        failed = true
        return Promise.reject(Object.assign(new Error(`${code}: resource busy, open`), { code }))
      }
      return original(...args)
    }) as typeof fs.readFile)
  }

  /** Two stored keys, then a cold module (a restart: no master key cached). */
  async function twoKeysThenRestart(): Promise<{
    ks: typeof import('./keystore')
    k1: Uint8Array
    k2: Uint8Array
  }> {
    vi.resetModules()
    const first = await import('./keystore')
    const k1 = await generateWorkspaceKey()
    const k2 = await generateWorkspaceKey()
    await first.storeWorkspaceKey(deriveKeyId(k1), k1, 'one')
    await first.storeWorkspaceKey(deriveKeyId(k2), k2, 'two')
    vi.resetModules()
    const ks = await import('./keystore')
    ;(await import('./unlock-state')).lockAll()
    return { ks, k1, k2 }
  }

  it('a transient master.key read error on unlock leaves both files unchanged and the next read succeeds', async () => {
    const { ks, k1, k2 } = await twoKeysThenRestart()
    const before = await snapshot()

    failNextRead('master.key')
    await expect(ks.resolveWorkspaceKey(deriveKeyId(k1))).rejects.toBeInstanceOf(
      ks.KeystoreUnreadableError
    )
    expect(await snapshot()).toEqual(before)

    const r1 = await ks.getWorkspaceKey(deriveKeyId(k1))
    const r2 = await ks.getWorkspaceKey(deriveKeyId(k2))
    expect(r1 && Buffer.from(r1).equals(Buffer.from(k1))).toBe(true)
    expect(r2 && Buffer.from(r2).equals(Buffer.from(k2))).toBe(true)
  })

  it('getWorkspaceKey reports no key (null) on an unreadable keystore without writing', async () => {
    const { ks, k1 } = await twoKeysThenRestart()
    const before = await snapshot()
    failNextRead('keystore.json')
    expect(await ks.getWorkspaceKey(deriveKeyId(k1))).toBeNull()
    expect(await snapshot()).toEqual(before)
  })

  it('a decryptString refusal on unlock does not reset the keystore', async () => {
    const { ks, k1, k2 } = await twoKeysThenRestart()
    const before = await snapshot()

    decryptFailures = 1
    expect(await ks.getWorkspaceKey(deriveKeyId(k1))).toBeNull()
    expect(await snapshot()).toEqual(before)

    const r2 = await ks.getWorkspaceKey(deriveKeyId(k2))
    expect(r2 && Buffer.from(r2).equals(Buffer.from(k2))).toBe(true)
  })

  it('a transient master.key read error on store rejects with a typed error and writes nothing', async () => {
    const { ks } = await twoKeysThenRestart()
    const before = await snapshot()
    const k3 = await generateWorkspaceKey()

    failNextRead('master.key')
    await expect(ks.storeWorkspaceKey(deriveKeyId(k3), k3, 'three')).rejects.toBeInstanceOf(
      ks.KeystoreUnreadableError
    )
    expect(await snapshot()).toEqual(before)
  })

  it('a transient keystore.json read error on store rejects and keeps every other entry', async () => {
    const { ks, k1, k2 } = await twoKeysThenRestart()
    // Warm the master key so the failing read is the keystore.json one.
    await ks.getWorkspaceKey(deriveKeyId(k1))
    const before = await snapshot()
    const k3 = await generateWorkspaceKey()

    failNextRead('keystore.json')
    await expect(ks.storeWorkspaceKey(deriveKeyId(k3), k3)).rejects.toBeInstanceOf(
      ks.KeystoreUnreadableError
    )
    expect(await snapshot()).toEqual(before)
    expect(Object.keys((await readKeystore()).keys).sort()).toEqual(
      [deriveKeyId(k1), deriveKeyId(k2)].sort()
    )
  })

  it('an unparseable keystore.json fails writes and listing, and is left as found', async () => {
    const { ks } = await twoKeysThenRestart()
    await fs.writeFile(secretsPath('keystore.json'), '{ "version": 1, "keys": {')
    const before = await snapshot()
    const k3 = await generateWorkspaceKey()

    await expect(ks.storeWorkspaceKey(deriveKeyId(k3), k3)).rejects.toBeInstanceOf(
      ks.KeystoreUnreadableError
    )
    await expect(ks.listKeyEntries()).rejects.toBeInstanceOf(ks.KeystoreUnreadableError)
    expect(await snapshot()).toEqual(before)
  })

  it('an undecryptable master key sets the old files aside before the store resets', async () => {
    const { ks, k1, k2 } = await twoKeysThenRestart()
    const before = await snapshot()
    // A keychain reset: master.key is read in full but no longer decrypts.
    await fs.writeFile(secretsPath('master.key'), Buffer.from('not-a-sealed-master-key'))
    const unreadableMaster = (await fs.readFile(secretsPath('master.key'))).toString('base64')
    const k3 = await generateWorkspaceKey()

    await ks.storeWorkspaceKey(deriveKeyId(k3), k3, 'three')

    const names = await fs.readdir(join(userDataDir, 'secrets'))
    const masterAside = names.filter((n) => /^master\.key\..+\.bak$/.test(n))
    const keystoreAside = names.filter((n) => /^keystore\.json\..+\.bak$/.test(n))
    expect(masterAside).toHaveLength(1)
    expect(keystoreAside).toHaveLength(1)
    expect((await fs.readFile(secretsPath(masterAside[0]))).toString('base64')).toBe(
      unreadableMaster
    )
    const asideStore = JSON.parse(await fs.readFile(secretsPath(keystoreAside[0]), 'utf-8'))
    expect(asideStore).toEqual(JSON.parse(before.keystore))
    expect(Object.keys(asideStore.keys).sort()).toEqual([deriveKeyId(k1), deriveKeyId(k2)].sort())
    // The rebuilt keystore holds the newly entered key, under a working master.
    expect(Object.keys((await readKeystore()).keys)).toEqual([deriveKeyId(k3)])
    vi.resetModules()
    const restarted = await import('./keystore')
    const r3 = await restarted.getWorkspaceKey(deriveKeyId(k3))
    expect(r3 && Buffer.from(r3).equals(Buffer.from(k3))).toBe(true)
  })

  it('a missing master.key still initializes, setting an orphaned keystore.json aside', async () => {
    const { ks, k1 } = await twoKeysThenRestart()
    await fs.rm(secretsPath('master.key'))
    expect(await ks.getWorkspaceKey(deriveKeyId(k1))).toBeNull()
    const k3 = await generateWorkspaceKey()

    await ks.storeWorkspaceKey(deriveKeyId(k3), k3)

    const names = await fs.readdir(join(userDataDir, 'secrets'))
    expect(names.filter((n) => /^keystore\.json\..+\.bak$/.test(n))).toHaveLength(1)
    expect(names.filter((n) => /^master\.key\..+\.bak$/.test(n))).toHaveLength(0)
    expect(Object.keys((await readKeystore()).keys)).toEqual([deriveKeyId(k3)])
  })

  it('a first use with no secrets folder initializes without setting anything aside', async () => {
    vi.resetModules()
    const ks = await import('./keystore')
    const k = await generateWorkspaceKey()
    await ks.storeWorkspaceKey(deriveKeyId(k), k)
    const names = (await fs.readdir(join(userDataDir, 'secrets'))).sort()
    expect(names).toEqual(['keystore.json', 'master.key'])
  })
})
