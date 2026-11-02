/**
 * REQ-0073 — keystore management: metadata-only listing (no key material, no
 * unwrap), delete, and proactive add with its conflict semantics.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let userDataDir: string
let backend = 'kwallet' // os-keychain by default
let decryptShouldThrow = false

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => backend,
    encryptString: (s: string) => Buffer.from(`sealed:${s}`, 'utf-8'),
    decryptString: (b: Buffer) => {
      if (decryptShouldThrow) throw new Error('keychain locked')
      return b.toString('utf-8').replace(/^sealed:/, '')
    }
  }
}))

import * as service from './service'
import { clearSessionMeta, listKeyEntries, storeWorkspaceKey } from './keystore'
import { lockAll } from './unlock-state'
import { writeWorkspaceStore } from '../state/recent-workspaces'
import { secrets, workspace } from '@fetchpier/core'

const { generateWorkspaceKey, formatKey, deriveKeyId } = secrets

beforeEach(async () => {
  userDataDir = await fs.mkdtemp(join(tmpdir(), 'fp-keymgmt-'))
  backend = 'kwallet'
  decryptShouldThrow = false
  lockAll()
  clearSessionMeta()
})
afterEach(async () => {
  lockAll()
  clearSessionMeta()
  await fs.rm(userDataDir, { recursive: true, force: true })
})

describe('listKeys (metadata only)', () => {
  it('returns entry metadata with no key material in the payload', async () => {
    const key = await generateWorkspaceKey()
    await service.addKey(formatKey(key), 'proyecto-x')

    const listing = await service.listKeys()
    expect(listing.entries).toHaveLength(1)
    const entry = listing.entries[0]
    expect(entry.keyId).toBe(deriveKeyId(key))
    expect(entry.workspaceHint).toBe('proyecto-x')
    expect(entry.backing).toBe('os-keychain')
    expect((entry as unknown as Record<string, unknown>).key).toBeUndefined()

    const serialized = JSON.stringify(listing)
    expect(serialized).not.toContain('enc:')
    expect(serialized).not.toContain('sealed:')
  })

  it('does not unwrap on list — the keychain stays untouched (CA-08)', async () => {
    const key = await generateWorkspaceKey()
    await service.addKey(formatKey(key))

    // Simulate a locked keychain: any unwrap would now throw.
    decryptShouldThrow = true
    const listing = await listKeyEntries()
    expect(listing).toHaveLength(1)
    expect(listing[0].keyId).toBe(deriveKeyId(key))
  })

  it('flags session-only entries under the degraded backend', async () => {
    backend = 'basic_text'
    const key = await generateWorkspaceKey()
    await service.addKey(formatKey(key), 'degraded-ws')

    const listing = await service.listKeys()
    expect(listing.entries).toHaveLength(1)
    expect(listing.entries[0].backing).toBe('session-only')
    // Nothing was written to disk under the degraded backend.
    await expect(fs.readFile(join(userDataDir, 'secrets', 'keystore.json'))).rejects.toThrow()
  })
})

describe('addKey conflict semantics', () => {
  it('stores a new key (added)', async () => {
    const key = await generateWorkspaceKey()
    const res = await service.addKey(formatKey(key), 'hint')
    expect(res.status).toBe('added')
    if (res.status === 'added') expect(res.entry.keyId).toBe(deriveKeyId(key))
  })

  it('rejects a malformed key before any store (invalid-format) — CA-04', async () => {
    const res = await service.addKey('FPK1-NOPE-NOPE')
    expect(res.status).toBe('invalid-format')
    expect((await service.listKeys()).entries).toHaveLength(0)
  })

  it('is a silent no-op on identical re-add, refreshing the hint — CA-05', async () => {
    const key = await generateWorkspaceKey()
    await service.addKey(formatKey(key), 'first')
    const res = await service.addKey(formatKey(key), 'second')
    expect(res.status).toBe('noop')
    const listing = await service.listKeys()
    expect(listing.entries).toHaveLength(1)
    expect(listing.entries[0].workspaceHint).toBe('second')
  })

  it('proposes replacement when a different key collides on keyId — CA-06', async () => {
    const keyA = await generateWorkspaceKey()
    const keyB = await generateWorkspaceKey()
    const keyIdB = deriveKeyId(keyB)
    // Forge the collision: store keyA's material under keyB's id.
    await storeWorkspaceKey(keyIdB, keyA, 'forged-hint')

    const conflict = await service.addKey(formatKey(keyB))
    expect(conflict.status).toBe('conflict')
    if (conflict.status === 'conflict') {
      expect(conflict.existing.workspaceHint).toBe('forged-hint')
      expect(conflict.existing.keyId).toBe(keyIdB)
    }

    // Declining leaves the original (still keyA's material under keyIdB).
    expect((await service.listKeys()).entries).toHaveLength(1)

    // Accepting replaces it with keyB.
    const replaced = await service.addKey(formatKey(keyB), 'new-hint', true)
    expect(replaced.status).toBe('updated')
    if (replaced.status === 'updated') expect(replaced.entry.workspaceHint).toBe('new-hint')
  })
})

describe('deleteKey', () => {
  it('removes a persisted entry from the keystore (CA-02)', async () => {
    const key = await generateWorkspaceKey()
    await service.addKey(formatKey(key))
    expect((await service.listKeys()).entries).toHaveLength(1)

    await service.deleteKey(deriveKeyId(key))
    expect((await service.listKeys()).entries).toHaveLength(0)
  })

  it('forgets a session-only entry (CA-07)', async () => {
    backend = 'basic_text'
    const key = await generateWorkspaceKey()
    await service.addKey(formatKey(key))
    expect((await service.listKeys()).entries).toHaveLength(1)

    await service.deleteKey(deriveKeyId(key))
    expect((await service.listKeys()).entries).toHaveLength(0)
  })

  // REQ write-safety / CA-05: a positive local reference blocks deletion.
  it('refuses to delete a key referenced by a locally-known workspace', async () => {
    const key = await generateWorkspaceKey()
    await service.addKey(formatKey(key), 'acme-api')
    const keyId = deriveKeyId(key)

    // A recent workspace whose manifest references this key.
    const wsPath = await fs.mkdtemp(join(tmpdir(), 'fp-keymgmt-ws-'))
    await fs.mkdir(join(wsPath, '.fetchpier'), { recursive: true })
    await workspace.openWorkspace(wsPath).secrets.writeManifest(await secrets.buildManifest(key))
    await writeWorkspaceStore({ path: wsPath, recent: [wsPath] })

    await expect(service.deleteKey(keyId)).rejects.toThrow(/KEY_IN_USE/)
    // The key is still present — nothing was removed.
    expect((await service.listKeys()).entries.some((e) => e.keyId === keyId)).toBe(true)

    await fs.rm(wsPath, { recursive: true, force: true })
  })

  // CA-06 boundary half: absence of a known reference never blocks.
  it('deletes a key with no locally-known reference', async () => {
    const key = await generateWorkspaceKey()
    await service.addKey(formatKey(key), 'acme-api')
    await writeWorkspaceStore({ path: '', recent: [] })

    await service.deleteKey(deriveKeyId(key))
    expect((await service.listKeys()).entries).toHaveLength(0)
  })
})
