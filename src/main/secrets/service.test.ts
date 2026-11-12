/**
 * REQ-0070 — desktop secrets service: setup → setSecret → reveal → unset, the
 * enter-key challenge, and atomic key rotation. Electron is mocked; the
 * filesystem is a real temp workspace.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let userDataDir: string
let backend = 'kwallet'

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => backend,
    encryptString: (s: string) => Buffer.from(`sealed:${s}`, 'utf-8'),
    decryptString: (b: Buffer) => b.toString('utf-8').replace(/^sealed:/, '')
  },
  systemPreferences: {
    canPromptTouchID: () => false,
    promptTouchID: async () => undefined
  }
}))

import * as service from './service'
import * as localValues from './local-values'
import { isUnlocked, lockAll } from './unlock-state'
import { listKeyEntries, storeWorkspaceKey } from './keystore'
import { secrets, workspace } from '@fetchpier/core'

let ws: string

async function makeWorkspace(): Promise<void> {
  ws = await fs.mkdtemp(join(tmpdir(), 'fp-secret-svc-'))
  await fs.mkdir(join(ws, '.fetchpier'), { recursive: true })
  await fs.writeFile(join(ws, '.fetchpier', 'settings.json'), JSON.stringify({ version: 1 }))
  const envDir = join(ws, 'environments', 'dev')
  await fs.mkdir(envDir, { recursive: true })
  await fs.writeFile(
    join(envDir, 'config.json'),
    JSON.stringify({
      id: 'dev',
      name: 'dev',
      variables: { baseUrl: 'https://x', apiToken: 'PLAINTOKEN' }
    })
  )
}

beforeEach(async () => {
  userDataDir = await fs.mkdtemp(join(tmpdir(), 'fp-secret-ud-'))
  backend = 'kwallet'
  lockAll()
  await makeWorkspace()
})
afterEach(async () => {
  lockAll()
  await fs.rm(userDataDir, { recursive: true, force: true })
  await fs.rm(ws, { recursive: true, force: true })
})

async function readEnv(): Promise<{ variables: Record<string, string | null> }> {
  return workspace.openWorkspace(ws).environments.read('dev')
}

async function readLocal(): Promise<{ variables: Record<string, string> }> {
  return secrets.readLocalValues(ws, 'dev')
}

describe('secrets service', () => {
  // CA-02: first secret triggers setup with a FPK1 key + manifest.
  it('setupKey creates a manifest and returns an FPK1 key', async () => {
    const { key, keyId } = await service.setupKey(ws)
    expect(key).toMatch(/^FPK1-/)
    expect(keyId).toMatch(/^[0-9a-f]{16}$/)
    const manifest = await workspace.openWorkspace(ws).secrets.readManifest()
    expect(manifest?.encryption.keyId).toBe(keyId)
    const status = await service.getStatus(ws)
    expect(status).toMatchObject({ hasManifest: true, unlocked: true, keyId })
  })

  // CA-01/CA-02: marking a variable secret encrypts it in place; plaintext is gone.
  it('setSecret encrypts the value in place as enc:v1 and drops the plaintext', async () => {
    await service.setupKey(ws)
    const updated = await service.setSecret(ws, 'dev', 'apiToken', 'PLAINTOKEN')
    expect(updated.variables.apiToken).toMatch(/^enc:v1:/)

    const onDisk = JSON.stringify(await readEnv())
    expect(onDisk).not.toContain('PLAINTOKEN')
    expect(onDisk).toContain('enc:v1:')
  })

  it('reveal returns the plaintext for a set secret (gate passes through)', async () => {
    await service.setupKey(ws)
    await service.setSecret(ws, 'dev', 'apiToken', 'PLAINTOKEN')
    expect(await service.revealValue(ws, 'dev', 'apiToken')).toBe('PLAINTOKEN')
  })

  // CA-04: a hand-edited `enc:` value that fails authentication resolves to
  // SECRETS_VALUE_CORRUPT (the reserved prefix makes "claims to be encrypted"
  // authoritative) naming the environment and variable.
  it('a fake `enc:` ciphertext fails as SECRETS_VALUE_CORRUPT (CA-04)', async () => {
    await service.setupKey(ws)
    const envDir = join(ws, 'environments', 'dev')
    await fs.writeFile(
      join(envDir, 'config.json'),
      JSON.stringify({ id: 'dev', name: 'dev', variables: { apiToken: 'enc:v1:garbage' } })
    )
    await expect(service.revealValue(ws, 'dev', 'apiToken')).rejects.toMatchObject({
      code: 'SECRETS_VALUE_CORRUPT'
    })
  })

  // CA-11: unmarking decrypts back to a plain variable.
  it('unsetSecret decrypts back into variables', async () => {
    await service.setupKey(ws)
    await service.setSecret(ws, 'dev', 'apiToken', 'PLAINTOKEN')
    const updated = await service.unsetSecret(ws, 'dev', 'apiToken')
    expect(updated.variables.apiToken).toBe('PLAINTOKEN')
  })

  // SEC-06: a double click on the lock runs setup twice. The second call must see
  // the first one's manifest instead of minting a second key.
  it('two concurrent setups produce one key, and the manifest names the stored key', async () => {
    const results = await Promise.allSettled([service.setupKey(ws), service.setupKey(ws)])
    const ok = results.filter(
      (r): r is PromiseFulfilledResult<{ key: string; keyId: string }> => r.status === 'fulfilled'
    )
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(ok).toHaveLength(1)
    expect(failed).toHaveLength(1)
    expect(failed[0].reason).toMatchObject({ code: 'WORKSPACE_INVALID' })

    const manifest = await workspace.openWorkspace(ws).secrets.readManifest()
    expect(manifest?.encryption.keyId).toBe(ok[0].value.keyId)
    // A restart still unlocks from the keystore, and the shown key opens the workspace.
    lockAll()
    expect(await service.getStatus(ws)).toMatchObject({ unlocked: true })
    lockAll()
    await fs.rm(join(userDataDir, 'secrets', 'keystore.json'), { force: true })
    expect(await service.enterKey(ws, ok[0].value.key)).toMatchObject({ ok: true })
  })

  it('two concurrent rotations run one after the other, the manifest on the last key', async () => {
    await service.setupKey(ws)
    const results = await Promise.allSettled([service.rotateKey(ws), service.rotateKey(ws)])
    const ok = results.filter(
      (r): r is PromiseFulfilledResult<{ key: string; keyId: string }> => r.status === 'fulfilled'
    )
    expect(ok).toHaveLength(2)
    const manifest = await workspace.openWorkspace(ws).secrets.readManifest()
    // Serialized: the second rotation runs on the first one's result, so the
    // manifest names the key the last dialog showed.
    expect(manifest?.encryption.keyId).toBe(ok[1].value.keyId)
    lockAll()
    expect(await service.getStatus(ws)).toMatchObject({ unlocked: true })
  })

  // SEC-09: a `$` name is the reserved dynamic-variable namespace. Writing one into
  // config.json made every later save of the environment fail.
  it('setSecret and clearSecret reject a reserved `$` name, writing nothing', async () => {
    await service.setupKey(ws)
    const before = await readEnv()
    await expect(service.setSecret(ws, 'dev', '$apiKey', 'hunter2')).rejects.toMatchObject({
      code: 'RESERVED_VARIABLE_NAME'
    })
    await expect(service.clearSecret(ws, 'dev', '$other')).rejects.toMatchObject({
      code: 'RESERVED_VARIABLE_NAME'
    })
    expect(await readEnv()).toEqual(before)
    // A name with `$` elsewhere is an ordinary name.
    const updated = await service.setSecret(ws, 'dev', 'api$Key', 'v')
    expect(updated.variables['api$Key']).toMatch(/^enc:v1:/)
  })

  it('deleteSecret still removes an existing reserved entry (the way out)', async () => {
    const envPath = join(ws, 'environments', 'dev', 'config.json')
    const raw = JSON.parse(await fs.readFile(envPath, 'utf-8'))
    raw.variables.$apiKey = null
    await fs.writeFile(envPath, JSON.stringify(raw))
    const updated = await service.deleteSecret(ws, 'dev', '$apiKey')
    expect('$apiKey' in updated.variables).toBe(false)
  })

  // needs-value: clearSecret authors a null entry.
  it('clearSecret sets a needs-value (null) entry', async () => {
    await service.setupKey(ws)
    const updated = await service.clearSecret(ws, 'dev', 'apiToken')
    expect(updated.variables.apiToken).toBeNull()
  })

  // REQ-0108 §6.10 — locking an unshared variable authors a needs-value secret and
  // must carry the variable's secrecy into the local layer: a plaintext local value
  // for a now-secret name would otherwise sit unencrypted (and read as invalid).
  it('clearSecret encrypts a plaintext local value for the name it makes secret', async () => {
    await service.setupKey(ws)
    // An unshared variable: a local value, no entry in the shared config.json.
    await localValues.setLocalValue(ws, 'dev', 'scriptToken', 'PLAIN-FROM-SCRIPT')
    expect((await readLocal()).variables.scriptToken).toBe('PLAIN-FROM-SCRIPT')

    const updated = await service.clearSecret(ws, 'dev', 'scriptToken')

    // Shared: the name is now a needs-value secret. Local: same value, encrypted.
    expect(updated.variables.scriptToken).toBeNull()
    const local = (await readLocal()).variables.scriptToken
    expect(secrets.isEncryptedValue(local)).toBe(true)
    expect(local).not.toContain('PLAIN-FROM-SCRIPT')
    // The local value is not published: the shared file never receives it.
    expect(Object.values(updated.variables)).not.toContain('PLAIN-FROM-SCRIPT')
  })

  // Idempotent: an already-encrypted local value is left byte-identical.
  it('clearSecret leaves an already-encrypted local value untouched', async () => {
    await service.setupKey(ws)
    await service.setSecret(ws, 'dev', 'apiToken', 'SECRET')
    await localValues.setLocalValue(ws, 'dev', 'apiToken', 'MY-OWN')
    const before = (await readLocal()).variables.apiToken

    await service.clearSecret(ws, 'dev', 'apiToken')
    expect((await readLocal()).variables.apiToken).toBe(before)
  })

  // No local entry for the name — nothing to propagate, no write, no failure.
  it('clearSecret is unaffected when the name has no local value', async () => {
    await service.setupKey(ws)
    const updated = await service.clearSecret(ws, 'dev', 'apiToken')
    expect(updated.variables.apiToken).toBeNull()
  })

  // CA-03: wrong key rejected by the challenge.
  it('enterKey rejects a wrong key and accepts the right one', async () => {
    const { key } = await service.setupKey(ws)
    lockAll() // simulate a fresh session with no live key

    const wrong = secrets.formatKey(await secrets.generateWorkspaceKey())
    expect(await service.enterKey(ws, wrong)).toMatchObject({ ok: false, reason: 'wrong-key' })
    expect(await service.enterKey(ws, 'FPK1-not-valid')).toMatchObject({ reason: 'invalid-format' })

    expect(await service.enterKey(ws, key)).toMatchObject({ ok: true })
    expect((await service.getStatus(ws)).unlocked).toBe(true)
  })

  // Security review Vuln 1: a crafted config.json whose `id` escapes the
  // workspace must not drive a write outside it — even via the no-key path.
  // REQ-0070 Vuln 1, under the identity split: a crafted `config.json` can still
  // carry a traversal string as its `id`, but the id is opaque and is never a path
  // segment — the write is addressed by the *folder*. So the traversal cannot
  // escape, and it cannot even be used to reach the environment.
  it('a crafted traversal id addresses nothing (no escape write)', async () => {
    // Plant a malicious config.json in a safely-named folder.
    const evilDir = join(ws, 'environments', 'legit')
    await fs.mkdir(evilDir, { recursive: true })
    const escapeTarget = join(userDataDir, 'fp-escape')
    const traversalId = `../../../../../../${escapeTarget.replace(/\\/g, '/')}`
    await fs.writeFile(
      join(evilDir, 'config.json'),
      JSON.stringify({ id: traversalId, name: 'legit', variables: { x: null } })
    )

    // The folder name does not identify the environment any more, so addressing
    // it by folder resolves to nothing.
    await expect(service.clearSecret(ws, 'legit', 'x')).rejects.toMatchObject({
      code: 'ENVIRONMENT_NOT_FOUND'
    })

    // clearSecret requires no key, so the traversal id itself is the real probe:
    // it resolves to the folder that holds it and the write lands *inside*.
    await service.clearSecret(ws, traversalId, 'x')
    await expect(fs.access(join(escapeTarget, 'config.json'))).rejects.toBeTruthy()
    const written = JSON.parse(await fs.readFile(join(evilDir, 'config.json'), 'utf-8'))
    expect(written.id).toBe(traversalId)
    // The folder is derived from the path the config was read from and is never
    // serialized into the file.
    expect(Object.keys(written).sort()).toEqual(['id', 'name', 'variables'])
  })

  // CA-19: a corrupt keystore entry (wrapped value mangled) is silently replaced
  // by a challenge-validated entered key — no crash, no partial unlock, no extra
  // prompt, and a subsequent "restart" unlocks with no dialog.
  it('replaces a corrupt keystore entry on enter-key without an extra prompt', async () => {
    const { key, keyId } = await service.setupKey(ws)
    await service.setSecret(ws, 'dev', 'apiToken', 'PLAINTOKEN')

    // Simulate a fresh session, then corrupt the wrapped key on disk.
    lockAll()
    const keystorePath = join(userDataDir, 'secrets', 'keystore.json')
    const store = JSON.parse(await fs.readFile(keystorePath, 'utf-8')) as {
      version: number
      keys: Record<string, { key: string; createdAt: string; lastUsedAt?: string }>
    }
    const before = store.keys[keyId].key
    // Flip a byte inside the base64 payload (after the `enc:v1:` prefix).
    const head = before.slice(0, 8) // "enc:v1:" + first char
    const flipped = before[8] === 'A' ? 'B' : 'A'
    store.keys[keyId].key = `${head}${flipped}${before.slice(9)}`
    await fs.writeFile(keystorePath, JSON.stringify(store, null, 2))

    // The corrupt entry yields no usable key: the workspace reports locked
    // (the enter-key dialog would show), never a crash or partial unlock.
    expect((await service.getStatus(ws)).unlocked).toBe(false)

    // Entering the correct key unlocks and silently replaces the entry.
    expect(await service.enterKey(ws, key)).toMatchObject({ ok: true, keyId })
    const after = JSON.parse(await fs.readFile(keystorePath, 'utf-8')) as typeof store
    expect(after.keys[keyId].key).not.toBe(store.keys[keyId].key)

    // A subsequent restart unlocks with no dialog.
    lockAll()
    expect((await service.getStatus(ws)).unlocked).toBe(true)
  })

  // CA-09: rotation re-encrypts everything; old key no longer decrypts, new does.
  it('rotateKey re-encrypts all secrets and changes the keyId', async () => {
    const setup = await service.setupKey(ws)
    await service.setSecret(ws, 'dev', 'apiToken', 'PLAINTOKEN')
    const before = (await readEnv()).variables.apiToken as string

    const rotated = await service.rotateKey(ws)
    expect(rotated.keyId).not.toBe(setup.keyId)

    const after = (await readEnv()).variables.apiToken as string
    expect(after).not.toBe(before)
    // The value still reveals correctly under the new key.
    expect(await service.revealValue(ws, 'dev', 'apiToken')).toBe('PLAINTOKEN')
    // The manifest keyId advanced.
    expect((await workspace.openWorkspace(ws).secrets.readManifest())?.encryption.keyId).toBe(
      rotated.keyId
    )
  })

  // REQ-0074 CA-08: rotation on this machine carries the local value layer.
  it('rotateKey re-encrypts the local layer under the new key', async () => {
    const setup = await service.setupKey(ws)
    await service.setSecret(ws, 'dev', 'apiToken', 'PLAINTOKEN')
    // A local override of the secret (encrypted under the old key).
    const localMod = await import('./local-values')
    await localMod.setLocalValue(ws, 'dev', 'apiToken', 'LOCAL-TOKEN')
    const beforeLocal = (await secrets.readLocalValues(ws, 'dev')).variables.apiToken

    const rotated = await service.rotateKey(ws)
    expect(rotated.keyId).not.toBe(setup.keyId)

    const lv = await secrets.readLocalValues(ws, 'dev')
    expect(lv.keyId).toBe(rotated.keyId)
    expect(lv.variables.apiToken).not.toBe(beforeLocal)
    // The local override still reveals correctly under the new key.
    expect(await localMod.revealLocalValue(ws, 'dev', 'apiToken')).toBe('LOCAL-TOKEN')
  })

  // SEC-05: an environment the listing cannot read would keep its secrets under
  // the old key while the manifest moves on, so rotation refuses up front.
  it('rotateKey refuses when an environment config.json is unreadable, writing nothing', async () => {
    const setup = await service.setupKey(ws)
    await service.setSecret(ws, 'dev', 'apiToken', 'PLAINTOKEN')
    const stagingDir = join(ws, 'environments', 'staging')
    await fs.mkdir(stagingDir, { recursive: true })
    const conflicted = '<<<<<<< HEAD\n{"id":"staging"}\n=======\n{"id":"staging"}\n>>>>>>> branch\n'
    await fs.writeFile(join(stagingDir, 'config.json'), conflicted)
    const devBefore = await fs.readFile(join(ws, 'environments', 'dev', 'config.json'), 'utf-8')

    await expect(service.rotateKey(ws)).rejects.toMatchObject({
      code: 'WORKSPACE_INVALID',
      message: expect.stringContaining('staging')
    })

    expect((await workspace.openWorkspace(ws).secrets.readManifest())?.encryption.keyId).toBe(
      setup.keyId
    )
    expect(await fs.readFile(join(ws, 'environments', 'dev', 'config.json'), 'utf-8')).toBe(
      devBefore
    )
    expect(await fs.readFile(join(stagingDir, 'config.json'), 'utf-8')).toBe(conflicted)
  })

  // SEC-08: after a rotation pulled from a teammate, an environment never opened
  // since still has its local file under the earlier (retained) key.
  it('rotateKey succeeds when a local file is still under an earlier retained key', async () => {
    const k1 = await secrets.generateWorkspaceKey()
    const m1 = await secrets.buildManifest(k1)
    await workspace.openWorkspace(ws).secrets.writeManifest(m1)
    await storeWorkspaceKey(m1.encryption.keyId, k1, 'old')
    await secrets.writeLocalValues(ws, 'dev', {
      version: 1,
      keyId: m1.encryption.keyId,
      variables: { apiToken: await secrets.encryptValue(k1, 'apiToken', 'LOCAL-TOKEN') }
    })
    // The pulled rotation: manifest + shared config now under K2, K2 entered here.
    const k2 = await secrets.generateWorkspaceKey()
    const m2 = await secrets.buildManifest(k2)
    await workspace.openWorkspace(ws).secrets.writeManifest(m2)
    await storeWorkspaceKey(m2.encryption.keyId, k2, 'new')
    await fs.writeFile(
      join(ws, 'environments', 'dev', 'config.json'),
      JSON.stringify({
        id: 'dev',
        name: 'dev',
        variables: { apiToken: await secrets.encryptValue(k2, 'apiToken', 'SHARED') }
      })
    )

    const rotated = await service.rotateKey(ws)

    const lv = await readLocal()
    expect((lv as { keyId?: string }).keyId).toBe(rotated.keyId)
    expect(await localValues.revealLocalValue(ws, 'dev', 'apiToken')).toBe('LOCAL-TOKEN')
    expect(await service.revealValue(ws, 'dev', 'apiToken')).toBe('SHARED')
  })

  // SEC-08: a local value that really is corrupt names its variable, not "(local)".
  it('rotateKey names the real variable when a local value cannot be decrypted', async () => {
    const setup = await service.setupKey(ws)
    await secrets.writeLocalValues(ws, 'dev', {
      version: 1,
      keyId: setup.keyId,
      variables: {
        apiToken: 'enc:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
      }
    })

    await expect(service.rotateKey(ws)).rejects.toMatchObject({
      code: 'SECRETS_VALUE_CORRUPT',
      message: expect.stringContaining('"apiToken"')
    })
    expect((await workspace.openWorkspace(ws).secrets.readManifest())?.encryption.keyId).toBe(
      setup.keyId
    )
  })

  // ── REQ-0077: direct secret deletion ──────────────────────────────────────

  // CA-01: the encrypted entry leaves config.json; no plaintext was ever written.
  it('deleteSecret removes the encrypted entry from config.json (no exposure)', async () => {
    await service.setupKey(ws)
    await service.setSecret(ws, 'dev', 'apiToken', 'PLAINTOKEN')

    const updated = await service.deleteSecret(ws, 'dev', 'apiToken')
    expect('apiToken' in updated.variables).toBe(false)

    const onDisk = JSON.stringify(await readEnv())
    expect(onDisk).not.toContain('apiToken')
    expect(onDisk).not.toContain('PLAINTOKEN')
    expect(onDisk).not.toContain('enc:v1:')
    // Plain siblings are untouched.
    expect((await readEnv()).variables.baseUrl).toBe('https://x')
  })

  // CA-07: deletion needs no key — it never decrypts. With no key available at all
  // (keystore removed), any decrypt attempt would throw SECRETS_KEY_MISSING; the
  // deletion still succeeds.
  it('deleteSecret needs no key (succeeds with no key available)', async () => {
    await service.setupKey(ws)
    await service.setSecret(ws, 'dev', 'apiToken', 'PLAINTOKEN')
    // Drop the live cache and remove the on-disk key so the workspace is truly locked.
    lockAll()
    await fs.rm(join(userDataDir, 'secrets'), { recursive: true, force: true })
    expect((await service.getStatus(ws)).unlocked).toBe(false)

    const updated = await service.deleteSecret(ws, 'dev', 'apiToken')
    expect('apiToken' in updated.variables).toBe(false)
    expect('apiToken' in (await readEnv()).variables).toBe(false)
  })

  // CA-02: deletion removes the local override too (not demoted to local-only),
  // and unlinks localvalues.json when it becomes empty.
  it('deleteSecret removes the local override and unlinks the empty local file', async () => {
    await service.setupKey(ws)
    await service.setSecret(ws, 'dev', 'apiToken', 'PLAINTOKEN')
    const localMod = await import('./local-values')
    await localMod.setLocalValue(ws, 'dev', 'apiToken', 'LOCAL-TOKEN')
    const localPath = join(ws, 'environments', 'dev', '.state', 'localvalues.json')
    await expect(fs.access(localPath)).resolves.toBeUndefined() // exists before

    await service.deleteSecret(ws, 'dev', 'apiToken')

    // Shared gone…
    expect('apiToken' in (await readEnv()).variables).toBe(false)
    // …and the local override is gone too (file unlinked, not demoted).
    await expect(fs.access(localPath)).rejects.toBeTruthy()
    expect((await secrets.readLocalValues(ws, 'dev')).variables.apiToken).toBeUndefined()
  })

  // CA-03: deleting the last secret leaves the workspace key in the keystore.
  it('deleteSecret leaves the workspace key in the keystore', async () => {
    const { keyId } = await service.setupKey(ws)
    await service.setSecret(ws, 'dev', 'apiToken', 'PLAINTOKEN')

    await service.deleteSecret(ws, 'dev', 'apiToken')

    const keystore = JSON.parse(
      await fs.readFile(join(userDataDir, 'secrets', 'keystore.json'), 'utf-8')
    ) as { keys: Record<string, unknown> }
    expect(keystore.keys[keyId]).toBeDefined()
    // The manifest (key custody) is untouched.
    expect((await workspace.openWorkspace(ws).secrets.readManifest())?.encryption.keyId).toBe(keyId)
  })

  // CA-04: a needs-value (null) secret is removed from both layers.
  it('deleteSecret removes a needs-value (null) secret', async () => {
    await service.setupKey(ws)
    await service.clearSecret(ws, 'dev', 'apiToken') // null entry
    expect((await readEnv()).variables.apiToken).toBeNull()

    const updated = await service.deleteSecret(ws, 'dev', 'apiToken')
    expect('apiToken' in updated.variables).toBe(false)
    expect('apiToken' in (await readEnv()).variables).toBe(false)
  })

  // REQ §5.3: idempotent — deleting an absent name is a no-op success.
  it('deleteSecret is idempotent for an absent name', async () => {
    await service.setupKey(ws)
    const updated = await service.deleteSecret(ws, 'dev', 'doesNotExist')
    expect('doesNotExist' in updated.variables).toBe(false)
    // Existing entries survive.
    expect(updated.variables.apiToken).toBe('PLAINTOKEN')
  })
})

describe('secrets service — workspace switch', () => {
  // On session-only the in-memory key is the only copy: a switch must keep it
  // (and its "This session only" entry) until quit.
  it('session-only: a switch keeps the workspace key and its session entry', async () => {
    backend = 'basic_text'
    const { keyId } = await service.setupKey(ws)

    service.resetSecretsOnWorkspaceSwitch()
    service.resetSecretsOnWorkspaceSwitch()

    expect(isUnlocked(keyId)).toBe(true)
    expect((await service.getStatus(ws)).unlocked).toBe(true)
    expect((await listKeyEntries()).map((e) => [e.keyId, e.backing])).toContainEqual([
      keyId,
      'session-only'
    ])
  })

  it('os-keychain: a switch drops the live key, which re-unlocks lazily from the keystore', async () => {
    const { keyId } = await service.setupKey(ws)

    service.resetSecretsOnWorkspaceSwitch()

    expect(isUnlocked(keyId)).toBe(false)
    expect((await service.getStatus(ws)).unlocked).toBe(true)
    expect(isUnlocked(keyId)).toBe(true)
  })
})
