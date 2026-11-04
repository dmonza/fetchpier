import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { decryptValue, encryptValue, generateWorkspaceKey } from './crypto'
import { deriveKeyId } from './key'
import {
  classifyLocalWrite,
  emptyLocalValues,
  isReservedPrefixValue,
  localValuesPath,
  mergeEnvironmentLayers,
  persistScriptEnvChanges,
  readLocalValues,
  writeLocalValues,
  type LocalValuesFile
} from './local-values'

const KEY_ID = 'a3f29c01b7e4d2f0'

function local(variables: Record<string, string>, keyId?: string): LocalValuesFile {
  return { version: 1, variables, ...(keyId ? { keyId } : {}) }
}

// ── mergeEnvironmentLayers (REQ-0076: one unified `variables` map) ─────────────

describe('mergeEnvironmentLayers — plain precedence', () => {
  it('local plain override wins over shared plain (CA-01)', () => {
    const merged = mergeEnvironmentLayers(
      { variables: { baseUrl: 'https://api.example.com' } },
      local({ baseUrl: 'http://localhost:3000' }),
      undefined
    )
    expect(merged.variables.baseUrl).toBe('http://localhost:3000')
    expect(merged.overrides).toContain('baseUrl')
    expect(merged.localOnly).toEqual([])
  })

  it('shared plain with no override is untouched', () => {
    const merged = mergeEnvironmentLayers(
      { variables: { a: '1', b: '2' } },
      local({ a: 'one' }),
      undefined
    )
    expect(merged.variables).toEqual({ a: 'one', b: '2' })
  })

  it('local-only names become plaintext variables and are flagged (CA-04)', () => {
    const merged = mergeEnvironmentLayers(
      { variables: { a: '1' } },
      local({ debugFlag: 'true' }),
      undefined
    )
    expect(merged.variables.debugFlag).toBe('true')
    expect(merged.localOnly).toEqual(['debugFlag'])
    expect(merged.overrides).toEqual([])
  })

  it('splits the unified shared map by value shape (CA-01)', () => {
    const merged = mergeEnvironmentLayers(
      { variables: { a: '1', s: 'enc:v1:x', n: null } },
      emptyLocalValues(),
      KEY_ID
    )
    expect(merged.variables).toEqual({ a: '1' })
    expect(merged.secretsMap).toEqual({ s: 'enc:v1:x', n: null })
    expect(merged.overrides).toEqual([])
    expect(merged.localOnly).toEqual([])
    expect(merged.orphans).toEqual([])
    expect(merged.invalid).toEqual([])
  })
})

describe('mergeEnvironmentLayers — secret overrides', () => {
  it('encrypted override under the current keyId wins (override)', () => {
    const merged = mergeEnvironmentLayers(
      { variables: { apiToken: 'enc:v1:SHARED' } },
      local({ apiToken: 'enc:v1:LOCAL' }, KEY_ID),
      KEY_ID
    )
    expect(merged.secretsMap.apiToken).toBe('enc:v1:LOCAL')
    expect(merged.overrides).toContain('apiToken')
    expect(merged.orphans).toEqual([])
  })

  it('encrypted override under a stale keyId is an orphan → falls back to shared (CA-07)', () => {
    const merged = mergeEnvironmentLayers(
      { variables: { apiToken: 'enc:v1:SHARED' } },
      local({ apiToken: 'enc:v1:LOCAL' }, 'OLDKEYID'),
      KEY_ID
    )
    expect(merged.secretsMap.apiToken).toBe('enc:v1:SHARED')
    expect(merged.orphans).toContain('apiToken')
    expect(merged.overrides).toEqual([])
  })

  it('plaintext value for a secret name is invalid → falls back to shared (CA-04)', () => {
    const merged = mergeEnvironmentLayers(
      { variables: { apiToken: 'enc:v1:SHARED' } },
      local({ apiToken: 'plain-text-leak' }, KEY_ID),
      KEY_ID
    )
    expect(merged.secretsMap.apiToken).toBe('enc:v1:SHARED')
    expect(merged.invalid).toContain('apiToken')
    expect(merged.overrides).toEqual([])
  })

  it('an invalid secret override does not affect other overrides', () => {
    const merged = mergeEnvironmentLayers(
      { variables: { baseUrl: 'shared', apiToken: 'enc:v1:SHARED' } },
      local({ apiToken: 'leak', baseUrl: 'local' }, KEY_ID),
      KEY_ID
    )
    expect(merged.invalid).toEqual(['apiToken'])
    expect(merged.variables.baseUrl).toBe('local')
    expect(merged.overrides).toContain('baseUrl')
  })

  it('override of a needs-value (null) shared secret keeps the template null in shared map only', () => {
    const merged = mergeEnvironmentLayers(
      { variables: { apiToken: null } },
      local({ apiToken: 'enc:v1:LOCAL' }, KEY_ID),
      KEY_ID
    )
    expect(merged.secretsMap.apiToken).toBe('enc:v1:LOCAL')
    expect(merged.overrides).toContain('apiToken')
  })

  it('null shared secret with no override stays null (needs-value preserved)', () => {
    const merged = mergeEnvironmentLayers(
      { variables: { apiToken: null } },
      emptyLocalValues(),
      KEY_ID
    )
    expect(merged.secretsMap.apiToken).toBeNull()
  })
})

describe('mergeEnvironmentLayers — needed-key analysis spans layers', () => {
  it('a run touching only plain values (local or shared) needs no secret', () => {
    const merged = mergeEnvironmentLayers(
      { variables: { baseUrl: 'shared', token: 'enc:v1:x' } },
      local({ baseUrl: 'local', debug: 'on' }),
      KEY_ID
    )
    expect(merged.secretsMap).toEqual({ token: 'enc:v1:x' })
    expect(merged.variables).toEqual({ baseUrl: 'local', debug: 'on' })
  })
})

// ── classifyLocalWrite / reserved prefix (REQ-0076: by value shape) ───────────

describe('classifyLocalWrite', () => {
  it('secret-shaped shared value (enc: or null) ⇒ secret', () => {
    expect(classifyLocalWrite('t', { t: 'enc:v1:x' })).toBe('secret')
    expect(classifyLocalWrite('t', { t: null })).toBe('secret')
  })
  it('plain shared value or absent name ⇒ plain', () => {
    expect(classifyLocalWrite('t', { t: 'plainval' })).toBe('plain')
    expect(classifyLocalWrite('t', { other: null })).toBe('plain')
    expect(classifyLocalWrite('t', undefined)).toBe('plain')
  })
})

describe('isReservedPrefixValue', () => {
  it('flags `enc:`-prefixed strings, passes ordinary values', () => {
    expect(isReservedPrefixValue('enc:v1:x')).toBe(true)
    expect(isReservedPrefixValue('enc:anything')).toBe(true)
    expect(isReservedPrefixValue('https://x')).toBe(false)
    expect(isReservedPrefixValue('')).toBe(false)
    expect(isReservedPrefixValue(null)).toBe(false)
  })
})

// ── read / write round-trip ───────────────────────────────────────────────────

describe('readLocalValues / writeLocalValues', () => {
  let ws = ''
  beforeEach(async () => {
    ws = await fs.mkdtemp(join(tmpdir(), 'local-values-test-'))
    // The local layer lives inside its environment's folder, which is resolved
    // from the opaque identifier — so the environment has to exist. `dev` is a
    // legacy-shaped environment (id === folder).
    const envDir = join(ws, 'environments', 'dev')
    await fs.mkdir(envDir, { recursive: true })
    await fs.writeFile(
      join(envDir, 'config.json'),
      JSON.stringify({ id: 'dev', name: 'dev', variables: {} })
    )
  })
  afterEach(async () => {
    await fs.rm(ws, { recursive: true, force: true })
  })

  it('returns an empty layer when the file is missing', async () => {
    expect(await readLocalValues(ws, 'dev')).toEqual({ version: 1, variables: {} })
  })

  it('round-trips plaintext values without a keyId', async () => {
    await writeLocalValues(ws, 'dev', local({ baseUrl: 'http://localhost' }))
    const back = await readLocalValues(ws, 'dev')
    expect(back.variables).toEqual({ baseUrl: 'http://localhost' })
    expect(back.keyId).toBeUndefined()
  })

  it('persists keyId only when an encrypted value is present', async () => {
    const key = await generateWorkspaceKey()
    const enc = await encryptValue(key, 'apiToken', 'secret')
    const keyId = deriveKeyId(key)
    await writeLocalValues(ws, 'dev', local({ apiToken: enc }, keyId))
    const back = await readLocalValues(ws, 'dev')
    expect(back.keyId).toBe(keyId)
    expect(back.variables.apiToken).toBe(enc)
  })

  it('drops keyId when no value is encrypted even if one was supplied', async () => {
    await writeLocalValues(ws, 'dev', local({ a: 'plain' }, KEY_ID))
    const back = await readLocalValues(ws, 'dev')
    expect(back.keyId).toBeUndefined()
  })

  it('unlinks the file when variables become empty', async () => {
    await writeLocalValues(ws, 'dev', local({ a: '1' }))
    await writeLocalValues(ws, 'dev', local({}))
    await expect(fs.access(localValuesPath(ws, 'dev'))).rejects.toThrow()
    expect(await readLocalValues(ws, 'dev')).toEqual({ version: 1, variables: {} })
  })

  it('degrades to an empty layer on corrupt JSON', async () => {
    const p = localValuesPath(ws, 'dev')
    await fs.mkdir(join(ws, 'environments', 'dev', '.state'), { recursive: true })
    await fs.writeFile(p, '{ not json', 'utf-8')
    expect(await readLocalValues(ws, 'dev')).toEqual({ version: 1, variables: {} })
  })

  it('drops a hand-edited `null` entry on read (null is invalid locally — CA-05)', async () => {
    const p = localValuesPath(ws, 'dev')
    await fs.mkdir(join(ws, 'environments', 'dev', '.state'), { recursive: true })
    await fs.writeFile(p, JSON.stringify({ version: 1, variables: { a: '1', bad: null } }), 'utf-8')
    const back = await readLocalValues(ws, 'dev')
    expect(back.variables).toEqual({ a: '1' })
  })

  it('ignores a legacy `values.json` — only `localvalues.json` is read (CA-07′)', async () => {
    const stateDir = join(ws, 'environments', 'dev', '.state')
    await fs.mkdir(stateDir, { recursive: true })
    // A stale legacy file sitting beside the unified one must not affect resolution.
    await fs.writeFile(
      join(stateDir, 'values.json'),
      JSON.stringify({ version: 1, values: { a: 'legacy' } })
    )
    await writeLocalValues(ws, 'dev', local({ a: 'current' }))
    expect((await readLocalValues(ws, 'dev')).variables).toEqual({ a: 'current' })
  })

  it('ignores a legacy `values.json` when no `localvalues.json` exists (empty layer)', async () => {
    const stateDir = join(ws, 'environments', 'dev', '.state')
    await fs.mkdir(stateDir, { recursive: true })
    await fs.writeFile(
      join(stateDir, 'values.json'),
      JSON.stringify({ version: 1, values: { a: 'legacy' } })
    )
    expect(await readLocalValues(ws, 'dev')).toEqual({ version: 1, variables: {} })
  })

  it('writes are confined: rejects a traversal environment id', () => {
    expect(() => localValuesPath(ws, '../escape')).toThrow()
  })

  // Atomic writes — closing the write-safety coverage gap: this writer used to
  // hand-roll its own temp+rename (missing the shared helper's Windows retry).
  it('retries the rename through a transient error and eventually succeeds (CA-01)', async () => {
    await writeLocalValues(ws, 'dev', local({ a: '1' }))
    const transient = Object.assign(new Error('EPERM: operation not permitted, rename'), {
      code: 'EPERM'
    })
    const renameSpy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(transient)

    await writeLocalValues(ws, 'dev', local({ a: '2' }))

    expect(renameSpy).toHaveBeenCalledTimes(2)
    renameSpy.mockRestore()
    expect((await readLocalValues(ws, 'dev')).variables).toEqual({ a: '2' })
  })

  it('leaves the previous content intact when the write is interrupted (CA-02)', async () => {
    await writeLocalValues(ws, 'dev', local({ a: 'original' }))
    const renameSpy = vi
      .spyOn(fs, 'rename')
      .mockRejectedValueOnce(new Error('ENOSPC: simulated disk full'))

    await expect(writeLocalValues(ws, 'dev', local({ a: 'new' }))).rejects.toThrow(/ENOSPC/)
    renameSpy.mockRestore()

    expect((await readLocalValues(ws, 'dev')).variables).toEqual({ a: 'original' })
    const siblings = await fs.readdir(join(ws, 'environments', 'dev', '.state'))
    expect(siblings).toEqual(['localvalues.json'])
  })
})

// ── persistScriptEnvChanges (CLI readiness: core owns script-write persistence) ──

describe('persistScriptEnvChanges', () => {
  let ws = ''
  let key: Uint8Array
  let keyId = ''
  const shared = { baseUrl: 'https://api.example.com', token: 'enc:v1:shared', unset: null }

  beforeEach(async () => {
    ws = await fs.mkdtemp(join(tmpdir(), 'persist-env-test-'))
    const envDir = join(ws, 'environments', 'dev')
    await fs.mkdir(envDir, { recursive: true })
    await fs.writeFile(
      join(envDir, 'config.json'),
      JSON.stringify({ id: 'dev', name: 'dev', variables: shared })
    )
    key = await generateWorkspaceKey()
    keyId = deriveKeyId(key)
  })
  afterEach(async () => {
    await fs.rm(ws, { recursive: true, force: true })
  })

  const persist = (
    changes: { set: Record<string, string>; removed: string[] } | undefined,
    opts: { currentKeyId?: string; getKey?: () => Promise<Uint8Array | null> } = {}
  ): ReturnType<typeof persistScriptEnvChanges> =>
    persistScriptEnvChanges({
      workspacePath: ws,
      environmentId: 'dev',
      changes,
      sharedVariables: shared,
      currentKeyId: 'currentKeyId' in opts ? opts.currentKeyId : keyId,
      getKey: opts.getKey ?? (async () => key)
    })

  it('writes a plain value in clear and a secret-named value encrypted under the current key', async () => {
    const warnings = await persist({
      set: { baseUrl: 'http://localhost', token: 'jwt' },
      removed: []
    })
    expect(warnings).toEqual([])
    const back = await readLocalValues(ws, 'dev')
    expect(back.variables.baseUrl).toBe('http://localhost')
    expect(back.variables.token.startsWith('enc:')).toBe(true)
    expect(await decryptValue(key, 'token', back.variables.token)).toBe('jwt')
    expect(back.keyId).toBe(keyId)
  })

  it('never asks for the key when no secret-named name is written', async () => {
    const getKey = vi.fn(async () => key)
    await persist({ set: { baseUrl: 'x' }, removed: [] }, { getKey })
    expect(getKey).not.toHaveBeenCalled()
  })

  it('without a key: skips the secret write with an advisory and still persists plain writes', async () => {
    const warnings = await persist(
      { set: { baseUrl: 'http://localhost', token: 'jwt' }, removed: [] },
      { getKey: async () => null }
    )
    expect(warnings).toEqual([
      { code: 'ENV_WRITE_NOT_PERSISTED', name: 'token', reason: 'KEY_MISSING' }
    ])
    const back = await readLocalValues(ws, 'dev')
    expect(back.variables).toEqual({ baseUrl: 'http://localhost' })
  })

  it('without a secrets manifest a secret-named write is KEY_MISSING', async () => {
    const warnings = await persist(
      { set: { token: 'jwt' }, removed: [] },
      { currentKeyId: undefined }
    )
    expect(warnings).toEqual([
      { code: 'ENV_WRITE_NOT_PERSISTED', name: 'token', reason: 'KEY_MISSING' }
    ])
  })

  it('local layer under an older key: secret writes skipped, plain persisted, existing entries byte-identical', async () => {
    const oldKey = await generateWorkspaceKey()
    const oldKeyId = deriveKeyId(oldKey)
    const oldEnc = await encryptValue(oldKey, 'token', 'old-secret')
    await writeLocalValues(ws, 'dev', local({ token: oldEnc, keep: 'v' }, oldKeyId))
    const getKey = vi.fn(async () => key)

    const warnings = await persist(
      { set: { token: 'new-secret', baseUrl: 'http://localhost' }, removed: [] },
      { getKey }
    )

    expect(warnings).toEqual([
      { code: 'ENV_WRITE_NOT_PERSISTED', name: 'token', reason: 'LOCAL_KEY_MISMATCH' }
    ])
    expect(getKey).not.toHaveBeenCalled()
    const back = await readLocalValues(ws, 'dev')
    expect(back.keyId).toBe(oldKeyId)
    expect(back.variables.token).toBe(oldEnc)
    expect(back.variables.baseUrl).toBe('http://localhost')
    expect(back.variables.keep).toBe('v')
  })

  it('a stale keyId with nothing encrypted is not a mismatch', async () => {
    await writeLocalValues(ws, 'dev', local({ keep: 'v' }, 'deadbeefdeadbeef'))
    const warnings = await persist({ set: { token: 'jwt' }, removed: [] })
    expect(warnings).toEqual([])
    expect((await readLocalValues(ws, 'dev')).keyId).toBe(keyId)
  })

  it('applies removals', async () => {
    await writeLocalValues(ws, 'dev', local({ baseUrl: 'a', other: 'b' }))
    await persist({ set: {}, removed: ['baseUrl'] })
    expect((await readLocalValues(ws, 'dev')).variables).toEqual({ other: 'b' })
  })

  it('a no-op when there are no changes', async () => {
    expect(await persist(undefined)).toEqual([])
    expect(await persist({ set: {}, removed: [] })).toEqual([])
    await expect(fs.access(localValuesPath(ws, 'dev'))).rejects.toThrow()
  })

  it('rejects a reserved `$` name and a plain value claiming the `enc:` prefix', async () => {
    await expect(persist({ set: { $guid: 'x' }, removed: [] })).rejects.toMatchObject({
      code: 'RESERVED_VARIABLE_NAME'
    })
    await expect(persist({ set: { baseUrl: 'enc:v1:fake' }, removed: [] })).rejects.toMatchObject({
      code: 'WORKSPACE_INVALID'
    })
  })
})
