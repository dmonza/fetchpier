import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkspace } from '../workspace/handle'
import { decryptValue, encryptValue, generateWorkspaceKey } from '../secrets/crypto'
import { deriveKeyId } from '../secrets/key'
import { buildManifest, serializeManifest } from '../secrets/manifest'
import { readLocalValues, writeLocalValues } from '../secrets/local-values'
import { createVariableSession, type VariableSessionOptions } from './variable-session'
import type { HttpRequest } from '@shared/types'

let ws = ''
let key: Uint8Array

async function writeEnv(variables: Record<string, string | null>): Promise<void> {
  const dir = join(ws, 'environments', 'dev')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    join(dir, 'config.json'),
    JSON.stringify({ id: 'dev', name: 'dev', variables })
  )
}

async function withManifest(): Promise<void> {
  const manifest = await buildManifest(key)
  await fs.mkdir(join(ws, '.fetchpier'), { recursive: true })
  await fs.writeFile(join(ws, '.fetchpier', 'secrets.json'), serializeManifest(manifest))
}

beforeEach(async () => {
  ws = await fs.mkdtemp(join(tmpdir(), 'var-session-'))
  key = await generateWorkspaceKey()
})
afterEach(async () => {
  await fs.rm(ws, { recursive: true, force: true })
})

const session = (over: Partial<VariableSessionOptions> = {}) =>
  createVariableSession({
    workspace: openWorkspace(ws),
    environmentId: 'dev',
    getKey: async () => key,
    persistence: 'memory',
    processEnv: {},
    ...over
  })

const get = (url: string): HttpRequest => ({ method: 'GET', url, headers: {} })

describe('createVariableSession — layering', () => {
  it('layers shared ($env resolved) → local → overrides', async () => {
    await writeEnv({ a: 'shared', b: 'shared', c: 'shared', fromEnv: '{{$env.FROM_OS}}' })
    await writeLocalValues(ws, 'dev', { version: 1, variables: { b: 'local', c: 'local' } })
    const s = await session({ overrides: { c: 'override' }, processEnv: { FROM_OS: 'os-value' } })
    const { request } = await s.prepare(get('https://x/'))
    expect(request.variables).toMatchObject({
      a: 'shared',
      b: 'local',
      c: 'override',
      fromEnv: 'os-value'
    })
  })

  it('uses the adapter-supplied base plain variables when given', async () => {
    await writeEnv({ a: 'disk' })
    const s = await session({ basePlainVariables: { a: 'renderer' } })
    expect((await s.prepare(get('https://x/'))).request.variables?.a).toBe('renderer')
  })
})

describe('createVariableSession — carry-forward', () => {
  it('a script write reaches every later send', async () => {
    await writeEnv({ baseUrl: 'https://api' })
    const s = await session()
    await s.apply({ set: { token: 'jwt-1' }, removed: [] })
    expect((await s.prepare(get('https://x/'))).request.variables?.token).toBe('jwt-1')
    await s.apply({ set: { token: 'jwt-2' }, removed: [] })
    expect((await s.prepare(get('https://x/'))).request.variables?.token).toBe('jwt-2')
  })

  it('a script write wins over an adapter override from then on', async () => {
    await writeEnv({})
    const s = await session({ overrides: { token: 'from-flag' } })
    expect((await s.prepare(get('https://x/'))).request.variables?.token).toBe('from-flag')
    await s.apply({ set: { token: 'from-script' }, removed: [] })
    expect((await s.prepare(get('https://x/'))).request.variables?.token).toBe('from-script')
  })

  it('unset removes the variable, and a later set brings it back', async () => {
    await writeEnv({ token: 'shared' })
    const s = await session()
    await s.apply({ set: {}, removed: ['token'] })
    expect((await s.prepare(get('https://x/'))).request.variables).not.toHaveProperty('token')
    await s.apply({ set: { token: 'again' }, removed: [] })
    expect((await s.prepare(get('https://x/'))).request.variables?.token).toBe('again')
  })

  it('apply(undefined) is a no-op', async () => {
    await writeEnv({ a: '1' })
    const s = await session()
    expect(await s.apply(undefined)).toEqual([])
    expect((await s.prepare(get('https://x/'))).request.variables?.a).toBe('1')
  })
})

describe('createVariableSession — secrets', () => {
  it('a secret-named script write is sent through a marker, never as a plain variable', async () => {
    await withManifest()
    await writeEnv({ token: await encryptValue(key, 'token', 'stored') })
    const s = await session()
    await s.apply({ set: { token: 'fresh-jwt' }, removed: [] })
    const prepared = await s.prepare({
      method: 'GET',
      url: 'https://x/',
      headers: { Authorization: 'Bearer {{token}}' }
    })
    expect(prepared.masker).toBeDefined()
    expect(prepared.masker!.scriptEnvironment.token).toBe('fresh-jwt')
    expect(prepared.request.variables?.token).toBe(prepared.masker!.markerVariables.token)
    expect(prepared.secretNames).toContain('token')
  })

  it('decrypts a referenced shared secret lazily, asking for the key once', async () => {
    await withManifest()
    await writeEnv({ token: await encryptValue(key, 'token', 'stored'), plain: 'p' })
    const getKey = vi.fn(async () => key)
    const s = await session({ getKey })
    await s.prepare(get('https://x/{{plain}}'))
    expect(getKey).not.toHaveBeenCalled()
    const prepared = await s.prepare(get('https://x/{{token}}'))
    await s.prepare(get('https://x/{{token}}'))
    expect(getKey).toHaveBeenCalledTimes(1)
    expect(prepared.masker!.scriptEnvironment.token).toBe('stored')
  })

  it('a referenced secret without a key is the contractual SECRETS_KEY_MISSING', async () => {
    await withManifest()
    await writeEnv({ token: await encryptValue(key, 'token', 'stored') })
    const s = await session({ getKey: async () => null })
    await expect(s.prepare(get('https://x/{{token}}'))).rejects.toMatchObject({
      code: 'SECRETS_KEY_MISSING'
    })
  })

  it('exposes orphans from a local layer under an older key', async () => {
    await withManifest()
    await writeEnv({ token: await encryptValue(key, 'token', 'stored') })
    const old = await generateWorkspaceKey()
    await writeLocalValues(ws, 'dev', {
      version: 1,
      keyId: deriveKeyId(old),
      variables: { token: await encryptValue(old, 'token', 'old') }
    })
    expect((await session()).orphans).toEqual(['token'])
  })
})

describe('createVariableSession — persistence policy', () => {
  it('memory never writes the workspace', async () => {
    await writeEnv({})
    const s = await session({ persistence: 'memory' })
    await s.apply({ set: { a: '1' }, removed: [] })
    expect((await readLocalValues(ws, 'dev')).variables).toEqual({})
  })

  it('persist writes the local layer and returns the writer advisories', async () => {
    await withManifest()
    await writeEnv({ token: await encryptValue(key, 'token', 'stored'), plain: 'p' })
    const s = await session({ persistence: 'persist', getKey: async () => null })
    const warnings = await s.apply({ set: { plain: 'local', token: 'jwt' }, removed: [] })
    expect(warnings).toEqual([
      { code: 'ENV_WRITE_NOT_PERSISTED', name: 'token', reason: 'KEY_MISSING' }
    ])
    expect((await readLocalValues(ws, 'dev')).variables).toEqual({ plain: 'local' })
    // Still used in memory for the rest of the session.
    const prepared = await s.prepare(get('https://x/{{token}}'))
    expect(prepared.masker!.scriptEnvironment.token).toBe('jwt')
  })

  it('persist encrypts a secret-named write with the provided key', async () => {
    await withManifest()
    await writeEnv({ token: await encryptValue(key, 'token', 'stored') })
    const s = await session({ persistence: 'persist' })
    await s.apply({ set: { token: 'jwt' }, removed: [] })
    const back = await readLocalValues(ws, 'dev')
    expect(await decryptValue(key, 'token', back.variables.token)).toBe('jwt')
  })

  it('no environment: nothing is persisted and nothing fails', async () => {
    const s = await session({ environmentId: null, persistence: 'persist' })
    expect(await s.apply({ set: { a: '1' }, removed: [] })).toEqual([])
    expect((await s.prepare(get('https://x/'))).request.variables?.a).toBe('1')
  })
})
