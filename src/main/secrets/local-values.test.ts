/**
 * REQ-0074 — desktop local value layer service: script-write persistence
 * (sticky secrecy, shared file untouched), lazy re-wrap after an external
 * rotation, orphan removal + notice, secrecy-transition propagation, and the
 * plaintext-override-of-secret validation. Electron is mocked; the filesystem is
 * a real temp workspace (mirrors service.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let userDataDir: string

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'kwallet',
    encryptString: (s: string) => Buffer.from(`sealed:${s}`, 'utf-8'),
    decryptString: (b: Buffer) => b.toString('utf-8').replace(/^sealed:/, '')
  },
  systemPreferences: {
    canPromptTouchID: () => false,
    promptTouchID: async () => undefined
  }
}))

import * as service from './service'
import * as local from './local-values'
import { lockAll } from './unlock-state'
import { storeWorkspaceKey } from './keystore'
import { secrets, workspace } from '@fetchpier/core'

let ws: string

async function writeConfig(
  envId: string,
  config: { variables?: Record<string, string>; secrets?: Record<string, string | null> }
): Promise<void> {
  const dir = join(ws, 'environments', envId)
  await fs.mkdir(dir, { recursive: true })
  // REQ-0076: one unified `variables` map (plain + secret-shaped values together).
  const variables = { ...(config.variables ?? {}), ...(config.secrets ?? {}) }
  await fs.writeFile(
    join(dir, 'config.json'),
    JSON.stringify({ id: envId, name: envId, variables })
  )
}

async function readValuesRaw(envId: string): Promise<string> {
  return fs.readFile(secrets.localValuesPath(ws, envId), 'utf-8')
}

beforeEach(async () => {
  userDataDir = await fs.mkdtemp(join(tmpdir(), 'fp-lv-ud-'))
  lockAll()
  ws = await fs.mkdtemp(join(tmpdir(), 'fp-lv-ws-'))
  await fs.mkdir(join(ws, '.fetchpier'), { recursive: true })
  await fs.writeFile(join(ws, '.fetchpier', 'settings.json'), JSON.stringify({ version: 1 }))
})

afterEach(async () => {
  lockAll()
  await fs.rm(userDataDir, { recursive: true, force: true })
  await fs.rm(ws, { recursive: true, force: true })
})

// ── Script-write persistence (CA-02, CA-03, CA-04) ────────────────────────────

describe('persistScriptEnvChanges', () => {
  it('writes a plain/local-only value as plaintext, never touching config.json (CA-02/CA-04)', async () => {
    await writeConfig('dev', { variables: { baseUrl: 'https://shared' } })
    const before = await fs.readFile(
      workspace.openWorkspace(ws).environments.configPath('dev'),
      'utf-8'
    )

    await local.persistScriptEnvChanges(ws, 'dev', {
      set: { token: 'abc', baseUrl: 'local' },
      removed: []
    })

    const after = await fs.readFile(
      workspace.openWorkspace(ws).environments.configPath('dev'),
      'utf-8'
    )
    expect(after).toBe(before) // shared file byte-identical (CA-02)

    const lv = await secrets.readLocalValues(ws, 'dev')
    expect(lv.variables).toEqual({ token: 'abc', baseUrl: 'local' })
    expect(lv.keyId).toBeUndefined()
  })

  it('encrypts a secret-named value under the manifest keyId, plaintext nowhere (CA-03)', async () => {
    await service.setupKey(ws)
    const { keyId } = (await service.getStatus(ws)) as { keyId: string }
    await writeConfig('dev', { secrets: { apiToken: null } })

    await local.persistScriptEnvChanges(ws, 'dev', {
      set: { apiToken: 'FRESH-TOKEN' },
      removed: []
    })

    const raw = await readValuesRaw('dev')
    expect(raw).not.toContain('FRESH-TOKEN')
    expect(raw).toContain('enc:v1:')
    const lv = await secrets.readLocalValues(ws, 'dev')
    expect(lv.keyId).toBe(keyId)
    expect(secrets.isEncryptedValue(lv.variables.apiToken)).toBe(true)

    // The shared config still carries null (template intact, CA-05).
    const env = await workspace.openWorkspace(ws).environments.read('dev')
    expect(env.variables.apiToken).toBeNull()
  })

  it('removed names are deleted from the local file', async () => {
    await writeConfig('dev', {})
    await local.persistScriptEnvChanges(ws, 'dev', { set: { a: '1', b: '2' }, removed: [] })
    await local.persistScriptEnvChanges(ws, 'dev', { set: {}, removed: ['a'] })
    const lv = await secrets.readLocalValues(ws, 'dev')
    expect(lv.variables).toEqual({ b: '2' })
  })

  it('rejects a plain local write claiming the reserved `enc:` prefix (REQ-0076 / CA-03)', async () => {
    await writeConfig('dev', { variables: { baseUrl: 'https://shared' } })
    await expect(
      local.persistScriptEnvChanges(ws, 'dev', { set: { baseUrl: 'enc:v1:fake' }, removed: [] })
    ).rejects.toThrow(/reserved/i)
    // Nothing persisted.
    const lv = await secrets.readLocalValues(ws, 'dev')
    expect(lv.variables.baseUrl).toBeUndefined()
  })

  it('rejects a local write to a reserved `$`-prefixed name (REQ-0087)', async () => {
    await writeConfig('dev', {})
    await expect(local.setLocalValue(ws, 'dev', '$x', 'v')).rejects.toThrow(
      /reserved for system dynamic variables/
    )
    const lv = await secrets.readLocalValues(ws, 'dev')
    expect(lv.variables.$x).toBeUndefined()
  })
})

// ── Resolution merge through the desktop entry point (CA-01) ──────────────────

describe('loadMergedEnvironment', () => {
  it('overlays a plain local override and exposes it for interpolation (CA-01)', async () => {
    await writeConfig('dev', { variables: { baseUrl: 'https://api.example.com' } })
    await local.setLocalValue(ws, 'dev', 'baseUrl', 'http://localhost:3000')

    const { merged, localPlainOverlay } = await local.loadMergedEnvironment(ws, 'dev')
    expect(merged.variables.baseUrl).toBe('http://localhost:3000')
    expect(localPlainOverlay).toEqual({ baseUrl: 'http://localhost:3000' })
  })
})

// ── Lazy re-wrap & orphans (CA-06, CA-07) ─────────────────────────────────────

describe('lazy re-wrap on a rotation pulled from elsewhere', () => {
  async function seedExternalRotation(opts: { retainOldKey: boolean }): Promise<{
    k2id: string
    k2: Uint8Array
  }> {
    // Old key K1: shared + local both encrypted under it.
    const k1 = await secrets.generateWorkspaceKey()
    const m1 = await secrets.buildManifest(k1)
    await workspace.openWorkspace(ws).secrets.writeManifest(m1)
    if (opts.retainOldKey) await storeWorkspaceKey(m1.encryption.keyId, k1, 'old')

    const encShared = await secrets.encryptValue(k1, 'apiToken', 'SHARED')
    await writeConfig('dev', { secrets: { apiToken: encShared } })
    const encLocal = await secrets.encryptValue(k1, 'apiToken', 'LOCAL-TOKEN')
    await secrets.writeLocalValues(ws, 'dev', {
      version: 1,
      keyId: m1.encryption.keyId,
      variables: { apiToken: encLocal }
    })

    // New key K2 becomes the manifest key (a rotation happened on another machine).
    const k2 = await secrets.generateWorkspaceKey()
    const m2 = await secrets.buildManifest(k2)
    await workspace.openWorkspace(ws).secrets.writeManifest(m2)
    await storeWorkspaceKey(m2.encryption.keyId, k2, 'new')
    return { k2id: m2.encryption.keyId, k2 }
  }

  it('re-wraps the local override under the current key when the old key is retained (CA-06)', async () => {
    const { k2id, k2 } = await seedExternalRotation({ retainOldKey: true })

    const { merged, orphanNotice } = await local.loadMergedEnvironment(ws, 'dev')
    expect(orphanNotice).toBeUndefined()

    const lv = await secrets.readLocalValues(ws, 'dev')
    expect(lv.keyId).toBe(k2id)
    expect(await secrets.decryptValue(k2, 'apiToken', lv.variables.apiToken)).toBe('LOCAL-TOKEN')
    // The local override (now under K2) wins in the merged map.
    expect(merged.secretsMap.apiToken).toBe(lv.variables.apiToken)
    expect(merged.orphans).toEqual([])
  })

  it('discards an orphaned override with a notice when the old key is gone (CA-07 desktop)', async () => {
    await seedExternalRotation({ retainOldKey: false })

    const { merged, orphanNotice } = await local.loadMergedEnvironment(ws, 'dev')
    expect(orphanNotice).toEqual({ environmentId: 'dev', variables: ['apiToken'] })

    // The encrypted override is removed; the file no longer carries it.
    const lv = await secrets.readLocalValues(ws, 'dev')
    expect(lv.variables.apiToken).toBeUndefined()
    // Resolution falls back to the shared secret value.
    const env = await workspace.openWorkspace(ws).environments.read('dev')
    expect(merged.secretsMap.apiToken).toBe(env.variables.apiToken)
  })
})

// ── Secrecy transitions (CA-10) ───────────────────────────────────────────────

describe('secrecy transition propagation', () => {
  it('encrypts a plaintext local override when the shared variable becomes secret, and back', async () => {
    await service.setupKey(ws)
    await writeConfig('dev', { variables: { token: 'shared-plain' } })
    await local.setLocalValue(ws, 'dev', 'token', 'my-local')
    let lv = await secrets.readLocalValues(ws, 'dev')
    expect(lv.variables.token).toBe('my-local') // plaintext while plain

    // Mark the shared variable secret → local override encrypts in place.
    await service.setSecret(ws, 'dev', 'token', 'shared-plain')
    lv = await secrets.readLocalValues(ws, 'dev')
    expect(secrets.isEncryptedValue(lv.variables.token)).toBe(true)
    expect(await local.revealLocalValue(ws, 'dev', 'token')).toBe('my-local')

    // Unmark → local override decrypts back to plaintext.
    await service.unsetSecret(ws, 'dev', 'token')
    lv = await secrets.readLocalValues(ws, 'dev')
    expect(lv.variables.token).toBe('my-local')
  })
})

// ── Concurrent writers (SEC-03) ───────────────────────────────────────────────

describe('concurrent local-values writers', () => {
  it('a secrecy propagation and editor/script writes running together keep every write', async () => {
    await service.setupKey(ws)
    await writeConfig('dev', { variables: { token: 'shared-plain' } })
    await local.setLocalValue(ws, 'dev', 'token', 'my-local')

    await Promise.all([
      local.propagateSecrecyTransition(ws, 'dev', 'token', 'secret'),
      local.setLocalValue(ws, 'dev', 'other', 'x'),
      local.persistScriptEnvChanges(ws, 'dev', { set: { fromScript: 'y' }, removed: [] })
    ])

    const lv = await secrets.readLocalValues(ws, 'dev')
    expect(Object.keys(lv.variables).sort()).toEqual(['fromScript', 'other', 'token'])
    expect(secrets.isEncryptedValue(lv.variables.token)).toBe(true)
  })

  it('a lazy re-wrap on load does not drop a script write landing at the same time', async () => {
    const k1 = await secrets.generateWorkspaceKey()
    const m1 = await secrets.buildManifest(k1)
    await workspace.openWorkspace(ws).secrets.writeManifest(m1)
    await storeWorkspaceKey(m1.encryption.keyId, k1, 'old')
    await writeConfig('dev', {
      secrets: { apiToken: await secrets.encryptValue(k1, 'apiToken', 'S') }
    })
    await secrets.writeLocalValues(ws, 'dev', {
      version: 1,
      keyId: m1.encryption.keyId,
      variables: { apiToken: await secrets.encryptValue(k1, 'apiToken', 'L') }
    })
    const k2 = await secrets.generateWorkspaceKey()
    const m2 = await secrets.buildManifest(k2)
    await workspace.openWorkspace(ws).secrets.writeManifest(m2)
    await storeWorkspaceKey(m2.encryption.keyId, k2, 'new')

    await Promise.all([
      local.loadMergedEnvironment(ws, 'dev'),
      secrets.persistScriptEnvChanges({
        workspacePath: ws,
        environmentId: 'dev',
        changes: { set: { plainVar: 'p' }, removed: [] },
        sharedVariables: {},
        currentKeyId: m2.encryption.keyId,
        getKey: async () => k2
      })
    ])

    const lv = await secrets.readLocalValues(ws, 'dev')
    expect(lv.variables.plainVar).toBe('p')
  })
})

// ── Plaintext-of-secret validation (CA-11) & view ─────────────────────────────

describe('getLocalView', () => {
  it('flags a hand-edited plaintext override of a secret name as invalid (CA-11)', async () => {
    await service.setupKey(ws)
    await writeConfig('dev', { secrets: { apiToken: null }, variables: { baseUrl: 'https://x' } })
    // Hand-write a plaintext value for the secret-named variable + a valid plain override.
    await secrets.writeLocalValues(ws, 'dev', {
      version: 1,
      variables: { apiToken: 'leaked-plaintext', baseUrl: 'http://local' }
    })

    const view = await local.getLocalView(ws, 'dev')
    const apiTokenRow = view.rows.find((r) => r.name === 'apiToken')
    const baseUrlRow = view.rows.find((r) => r.name === 'baseUrl')
    expect(apiTokenRow?.invalid).toBe(true)
    expect(apiTokenRow?.hasLocalOverride).toBe(false)
    // The other override is unaffected.
    expect(baseUrlRow?.hasLocalOverride).toBe(true)
    expect(baseUrlRow?.localDisplay).toBe('http://local')

    // Secret rows never expose plaintext in the view.
    expect(JSON.stringify(view)).not.toContain('leaked-plaintext')
  })

  it('lists a local-only variable flagged as such', async () => {
    await writeConfig('dev', {})
    await local.setLocalValue(ws, 'dev', 'debugFlag', 'true')
    const view = await local.getLocalView(ws, 'dev')
    const row = view.rows.find((r) => r.name === 'debugFlag')
    expect(row).toMatchObject({ sharedKind: 'absent', localOnly: true, localDisplay: 'true' })
  })
})

// ── Seeding (REQ-0075 §6.2 / CA-02, CA-09) ────────────────────────────────────

describe('seedLocalValue', () => {
  it('seeds a plain variable with the current shared value as plaintext (CA-02)', async () => {
    await writeConfig('dev', { variables: { baseUrl: 'https://shared.example.com' } })
    await local.seedLocalValue(ws, 'dev', 'baseUrl')

    const lv = await secrets.readLocalValues(ws, 'dev')
    expect(lv.variables.baseUrl).toBe('https://shared.example.com')
    expect(lv.keyId).toBeUndefined()
    // Resolution is value-identical until edited.
    const { merged } = await local.loadMergedEnvironment(ws, 'dev')
    expect(merged.variables.baseUrl).toBe('https://shared.example.com')
  })

  it('seeds a secret-named variable encrypted, plaintext nowhere on disk (op-check)', async () => {
    await service.setupKey(ws)
    await writeConfig('dev', {})
    await service.setSecret(ws, 'dev', 'apiToken', 'SHARED-SECRET')

    await local.seedLocalValue(ws, 'dev', 'apiToken')

    const raw = await readValuesRaw('dev')
    expect(raw).not.toContain('SHARED-SECRET')
    expect(raw).toContain('enc:v1:')
    expect(await local.revealLocalValue(ws, 'dev', 'apiToken')).toBe('SHARED-SECRET')
  })

  it('is a no-op for a needs-value (shared null) secret — nothing persisted (CA-06)', async () => {
    await service.setupKey(ws)
    await writeConfig('dev', { secrets: { apiToken: null } })

    await local.seedLocalValue(ws, 'dev', 'apiToken')

    const lv = await secrets.readLocalValues(ws, 'dev')
    expect(lv.variables.apiToken).toBeUndefined()
  })
})

// ── Divergence flag (REQ-0075 §6.3 / CA-03, CA-06) ────────────────────────────

describe('getLocalView — divergent', () => {
  it('reports a seeded (identical) plain override as not divergent, an edited one as divergent', async () => {
    await writeConfig('dev', { variables: { baseUrl: 'https://shared.example.com' } })
    await local.seedLocalValue(ws, 'dev', 'baseUrl')
    let row = (await local.getLocalView(ws, 'dev')).rows.find((r) => r.name === 'baseUrl')
    expect(row?.hasLocalOverride).toBe(true)
    expect(row?.divergent).toBe(false)

    await local.setLocalValue(ws, 'dev', 'baseUrl', 'http://localhost:3000')
    row = (await local.getLocalView(ws, 'dev')).rows.find((r) => r.name === 'baseUrl')
    expect(row?.divergent).toBe(true)
  })

  it('compares secret plaintexts: identical seed is silent, a different value diverges', async () => {
    await service.setupKey(ws)
    await writeConfig('dev', {})
    await service.setSecret(ws, 'dev', 'apiToken', 'SHARED-SECRET')

    await local.seedLocalValue(ws, 'dev', 'apiToken')
    let row = (await local.getLocalView(ws, 'dev')).rows.find((r) => r.name === 'apiToken')
    expect(row?.divergent).toBe(false)

    await local.setLocalValue(ws, 'dev', 'apiToken', 'DIFFERENT-SECRET')
    row = (await local.getLocalView(ws, 'dev')).rows.find((r) => r.name === 'apiToken')
    expect(row?.divergent).toBe(true)
  })

  it('reports a needs-value secret covered by a local value as divergent (CA-06)', async () => {
    await service.setupKey(ws)
    await writeConfig('dev', { secrets: { apiToken: null } })
    await local.setLocalValue(ws, 'dev', 'apiToken', 'my-local')

    const row = (await local.getLocalView(ws, 'dev')).rows.find((r) => r.name === 'apiToken')
    expect(row?.hasLocalOverride).toBe(true)
    expect(row?.divergent).toBe(true)
  })
})
