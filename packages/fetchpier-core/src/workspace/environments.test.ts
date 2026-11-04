import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deleteEnvironment,
  listEnvironmentFolders,
  listEnvironments,
  listEnvironmentsWithErrors,
  readEnvFile,
  saveEnvironment,
  writeEnvFile
} from './environments'
import { loadHttpSettings, loadHttpSettingsStrict } from './settings-store'
import type { Environment } from '@shared/types'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function newWorkspace(): string {
  const d = mkdtempSync(join(tmpdir(), 'fp-env-write-'))
  dirs.push(d)
  return d
}

describe('writeEnvFile — path-traversal hardening (REQ-0070 Vuln 1)', () => {
  it('writes a normal environment inside the workspace', async () => {
    const ws = newWorkspace()
    const env: Environment = { id: 'dev', folder: 'dev', name: 'dev', variables: { a: '1' } }
    await writeEnvFile(ws, env)
    const back = await readEnvFile(join(ws, 'environments', 'dev', 'config.json'))
    expect(back).toEqual(env)
  })

  // The write is keyed by `folder`, so that is the field the hardening guards.
  // The opaque `id` never reaches the filesystem at all.
  it('rejects an env folder that escapes the workspace', async () => {
    const ws = newWorkspace()
    const evil: Environment = {
      id: 'x',
      folder: '../../../../../../tmp/fp-evil',
      name: 'legit',
      variables: {}
    }
    await expect(writeEnvFile(ws, evil)).rejects.toThrow(
      /Unsafe environment folder|escapes workspace/i
    )
    // Nothing was created outside the workspace.
    await expect(fs.access(join('/tmp/fp-evil/config.json'))).rejects.toBeTruthy()
  })

  it('does not let a path-shaped identifier drive the write', async () => {
    const ws = newWorkspace()
    await writeEnvFile(ws, {
      id: '../../../../../../tmp/fp-evil',
      folder: 'dev',
      name: 'legit',
      variables: {}
    })
    const back = await readEnvFile(join(ws, 'environments', 'dev', 'config.json'))
    expect(back.id).toBe('../../../../../../tmp/fp-evil')
    await expect(fs.access(join('/tmp/fp-evil/config.json'))).rejects.toBeTruthy()
  })

  it('rejects an env folder with path separators or NUL', async () => {
    const ws = newWorkspace()
    for (const folder of ['a/b', 'a\\b', 'x\u0000y', '..']) {
      await expect(writeEnvFile(ws, { id: 'x', folder, name: 'n', variables: {} })).rejects.toThrow(
        /Unsafe/i
      )
    }
  })
})

describe('readEnvFile — unified shape + legacy shim (REQ-0076)', () => {
  it('loads a unified `variables` map mixing plain, enc: and null values', async () => {
    const ws = newWorkspace()
    const dir = join(ws, 'environments', 'dev')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      join(dir, 'config.json'),
      JSON.stringify({
        id: 'dev',
        name: 'dev',
        variables: { baseUrl: 'https://x', apiToken: 'enc:v1:abc', webhook: null }
      })
    )
    const env = await readEnvFile(join(dir, 'config.json'))
    expect(env.variables).toEqual({ baseUrl: 'https://x', apiToken: 'enc:v1:abc', webhook: null })
  })

  it('fails closed on a legacy split-shape config (a `secrets` key) — no partial env (CA-07′)', async () => {
    const ws = newWorkspace()
    const dir = join(ws, 'environments', 'dev')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      join(dir, 'config.json'),
      JSON.stringify({
        id: 'dev',
        name: 'dev',
        variables: { baseUrl: 'https://x' },
        secrets: { apiToken: 'enc:v1:abc', webhook: null }
      })
    )
    await expect(readEnvFile(join(dir, 'config.json'))).rejects.toMatchObject({
      code: 'WORKSPACE_INVALID'
    })
  })
})

describe('listEnvironments / listEnvironmentFolders (F4)', () => {
  it('returns [] when environments/ is absent', async () => {
    const ws = newWorkspace()
    expect(await listEnvironments(ws)).toEqual([])
    expect(await listEnvironmentFolders(ws)).toEqual([])
  })

  it('lists environments with a readable config and their ids', async () => {
    const ws = newWorkspace()
    await writeEnvFile(ws, { id: 'dev', folder: 'dev', name: 'Dev', variables: { a: '1' } })
    await writeEnvFile(ws, { id: 'prod', folder: 'prod', name: 'Prod', variables: {} })
    expect((await listEnvironments(ws)).map((e) => e.id).sort()).toEqual(['dev', 'prod'])
    expect((await listEnvironmentFolders(ws)).sort()).toEqual(['dev', 'prod'])
  })

  it('listEnvironments skips folders without a readable config.json', async () => {
    const ws = newWorkspace()
    await writeEnvFile(ws, { id: 'dev', folder: 'dev', name: 'Dev', variables: {} })
    await fs.mkdir(join(ws, 'environments', 'stray'), { recursive: true })
    expect((await listEnvironments(ws)).map((e) => e.id)).toEqual(['dev'])
    // listEnvironmentFolders is folder-based, so the stray folder is included.
    expect((await listEnvironmentFolders(ws)).sort()).toEqual(['dev', 'stray'])
  })
})

describe('deleteEnvironment (F4)', () => {
  it('removes the whole environment folder', async () => {
    const ws = newWorkspace()
    await writeEnvFile(ws, { id: 'dev', folder: 'dev', name: 'Dev', variables: { a: '1' } })
    await deleteEnvironment(ws, 'dev')
    await expect(fs.access(join(ws, 'environments', 'dev'))).rejects.toBeTruthy()
  })

  // Delete resolves the identifier to a folder first, so a stale identifier is a
  // surfaced not-found rather than a silent no-op — the panel reports it and
  // reloads the list instead of believing it deleted something.
  it('surfaces a not-found when the environment does not exist', async () => {
    const ws = newWorkspace()
    await expect(deleteEnvironment(ws, 'ghost')).rejects.toMatchObject({
      code: 'ENVIRONMENT_NOT_FOUND'
    })
  })

  it('rejects a path-shaped id — it resolves to no folder', async () => {
    const ws = newWorkspace()
    await expect(deleteEnvironment(ws, '../../x')).rejects.toMatchObject({
      code: 'ENVIRONMENT_NOT_FOUND'
    })
  })
})

describe('saveEnvironment — merge (F4, REQ-0076/0079/0087)', () => {
  const ENC = 'enc:v1:abc'

  /**
   * Save resolves its target folder from the opaque identifier, so the
   * environment has to exist: `env:save` overwrites, it never creates. Seed a
   * legacy-shaped one (id === folder) — that is what every pre-existing
   * workspace looks like.
   */
  async function seedDev(ws: string, variables: Record<string, string | null> = {}): Promise<void> {
    await writeEnvFile(ws, { id: 'dev', folder: 'dev', name: 'dev', variables })
  }

  it('writes plain variables in the renderer key order', async () => {
    const ws = newWorkspace()
    await seedDev(ws)
    await saveEnvironment(ws, {
      id: 'dev',
      folder: 'dev',
      name: 'dev',
      variables: { b: '2', a: '1' }
    })
    const back = await readEnvFile(join(ws, 'environments', 'dev', 'config.json'))
    expect(Object.keys(back.variables)).toEqual(['b', 'a'])
  })

  it('preserves the on-disk secret value, ignoring the renderer payload', async () => {
    const ws = newWorkspace()
    await writeEnvFile(ws, { id: 'dev', folder: 'dev', name: 'dev', variables: { sec: ENC } })
    await saveEnvironment(ws, {
      id: 'dev',
      folder: 'dev',
      name: 'dev',
      variables: { sec: 'enc:v1:STALE' }
    })
    const back = await readEnvFile(join(ws, 'environments', 'dev', 'config.json'))
    expect(back.variables.sec).toBe(ENC)
  })

  it('rejects a $-prefixed variable name', async () => {
    const ws = newWorkspace()
    await seedDev(ws)
    await expect(
      saveEnvironment(ws, { id: 'dev', folder: 'dev', name: 'dev', variables: { $x: 'v' } })
    ).rejects.toMatchObject({ code: 'RESERVED_VARIABLE_NAME' })
  })

  it('rejects a plain value claiming the reserved enc: prefix', async () => {
    const ws = newWorkspace()
    await seedDev(ws)
    await expect(
      saveEnvironment(ws, { id: 'dev', folder: 'dev', name: 'dev', variables: { fake: ENC } })
    ).rejects.toThrow(/reserved for encrypted secrets/)
  })

  it('merges concurrent edits to different variables against a baseline', async () => {
    const ws = newWorkspace()
    await writeEnvFile(ws, { id: 'dev', folder: 'dev', name: 'dev', variables: { A: '1', B: '1' } })
    await saveEnvironment(
      ws,
      { id: 'dev', folder: 'dev', name: 'dev', variables: { A: '2', B: '1' } },
      { A: '1', B: '1' }
    )
    await saveEnvironment(
      ws,
      { id: 'dev', folder: 'dev', name: 'dev', variables: { A: '1', B: '2' } },
      { A: '1', B: '1' }
    )
    const back = await readEnvFile(join(ws, 'environments', 'dev', 'config.json'))
    expect(back.variables).toEqual({ A: '2', B: '2' })
  })
})

describe('listEnvironmentsWithErrors (CLI hardening)', () => {
  it('lists readable environments and reports an unparseable config.json', async () => {
    const ws = newWorkspace()
    await writeEnvFile(ws, { id: 'a', folder: 'good', name: 'good', variables: {} })
    await fs.mkdir(join(ws, 'environments', 'broken'), { recursive: true })
    await fs.writeFile(join(ws, 'environments', 'broken', 'config.json'), '{ not json')
    await fs.mkdir(join(ws, 'environments', 'empty-folder'), { recursive: true })

    const { environments, unreadable } = await listEnvironmentsWithErrors(ws)

    expect(environments.map((e) => e.folder)).toEqual(['good'])
    // A folder with no config.json is simply not an environment.
    expect(unreadable).toEqual([
      {
        folder: 'broken',
        file: join(ws, 'environments', 'broken', 'config.json'),
        reason: expect.stringMatching(/JSON/i)
      }
    ])
    // The plain listing is unchanged.
    expect((await listEnvironments(ws)).map((e) => e.folder)).toEqual(['good'])
  })
})

describe('readEnvFile — a parseable file with a malformed shape is unreadable', () => {
  async function writeRaw(ws: string, folder: string, content: unknown): Promise<string> {
    const file = join(ws, 'environments', folder, 'config.json')
    await fs.mkdir(join(ws, 'environments', folder), { recursive: true })
    await fs.writeFile(file, JSON.stringify(content))
    return file
  }

  it.each([
    ['a missing name', { id: 'x', variables: {} }, '"name"'],
    ['a non-string name', { id: 'x', name: 42, variables: {} }, '"name"'],
    ['an empty name', { id: 'x', name: '', variables: {} }, '"name"'],
    ['a missing id', { name: 'x', variables: {} }, '"id"'],
    ['non-object variables', { id: 'x', name: 'x', variables: ['a'] }, '"variables"'],
    ['a top-level array', [1, 2], 'JSON object']
  ])('%s → WORKSPACE_INVALID naming the file and the field', async (_label, content, field) => {
    const ws = newWorkspace()
    const file = await writeRaw(ws, 'handmade', content)
    await expect(readEnvFile(file)).rejects.toMatchObject({
      code: 'WORKSPACE_INVALID',
      message: expect.stringContaining(field)
    })
  })

  it('a well-formed file without variables still reads as an empty map', async () => {
    const ws = newWorkspace()
    const file = await writeRaw(ws, 'plain', { id: 'p', name: 'plain' })
    expect((await readEnvFile(file)).variables).toEqual({})
  })

  it('one malformed environment no longer breaks the listing: it is reported, the rest listed', async () => {
    const ws = newWorkspace()
    await writeEnvFile(ws, { id: 'a', folder: 'good', name: 'good', variables: {} })
    const file = await writeRaw(ws, 'handmade', { id: 'h', variables: {} })

    const { environments, unreadable } = await listEnvironmentsWithErrors(ws)

    expect(environments.map((e) => e.folder)).toEqual(['good'])
    expect(unreadable).toEqual([
      { folder: 'handmade', file, reason: expect.stringContaining('"name"') }
    ])
    // The plain listing (desktop) skips it instead of throwing.
    expect((await listEnvironments(ws)).map((e) => e.folder)).toEqual(['good'])
  })
})

describe('loadHttpSettingsStrict (CLI hardening)', () => {
  it('a missing file means defaults', async () => {
    const ws = newWorkspace()
    expect((await loadHttpSettingsStrict(ws)).verifySsl).toBe(true)
  })

  it('reads a valid file like the lenient loader', async () => {
    const ws = newWorkspace()
    await fs.mkdir(join(ws, '.fetchpier'), { recursive: true })
    await fs.writeFile(
      join(ws, '.fetchpier', 'settings.json'),
      JSON.stringify({ version: 1, http: { verifySsl: false } })
    )
    expect((await loadHttpSettingsStrict(ws)).verifySsl).toBe(false)
  })

  it.each([
    ['invalid JSON', '{ nope'],
    ['a non-object', '[1, 2]']
  ])('an existing file with %s is WORKSPACE_INVALID naming the file', async (_label, content) => {
    const ws = newWorkspace()
    await fs.mkdir(join(ws, '.fetchpier'), { recursive: true })
    await fs.writeFile(join(ws, '.fetchpier', 'settings.json'), content)
    await expect(loadHttpSettingsStrict(ws)).rejects.toMatchObject({
      code: 'WORKSPACE_INVALID',
      message: expect.stringContaining(join(ws, '.fetchpier', 'settings.json'))
    })
    // The desktop's lenient loader still falls back to defaults.
    expect((await loadHttpSettings(ws)).verifySsl).toBe(true)
  })
})
