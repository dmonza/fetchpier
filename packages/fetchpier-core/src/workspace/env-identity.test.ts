import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createEnvironmentFile,
  deleteEnvironment,
  duplicateEnvironment,
  listEnvironments,
  readEnvFile,
  renameEnvironment,
  resolveEnvFolder,
  writeEnvFile
} from './environments'
import { captureFromResponse, getMatchingCookies } from '../requests/cookie-jar'
import { readLocalValues, writeLocalValues } from '../secrets/local-values'
import { MAX_ENV_FOLDER_NAME } from '@shared/lib/env-folder-name'

const dirs: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function newWorkspace(): string {
  const d = mkdtempSync(join(tmpdir(), 'fp-env-identity-'))
  dirs.push(d)
  return d
}

/** Write a `config.json` by hand — the shape a workspace has on disk. */
async function seed(
  ws: string,
  folder: string,
  config: { id: string; name: string; variables?: Record<string, string | null> }
): Promise<void> {
  const dir = join(ws, 'environments', folder)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    join(dir, 'config.json'),
    JSON.stringify({ variables: {}, ...config }, null, 2)
  )
}

const configOf = (ws: string, folder: string): string =>
  join(ws, 'environments', folder, 'config.json')

const folderExists = async (ws: string, folder: string): Promise<boolean> =>
  fs
    .access(join(ws, 'environments', folder))
    .then(() => true)
    .catch(() => false)

// ── CA-01 / CA-06 — creation ────────────────────────────────────────────────

describe('createEnvironmentFile — opaque id, derived folder (CA-01, CA-06)', () => {
  it('creates the derived folder, stores the typed name verbatim, and generates an opaque id', async () => {
    const ws = newWorkspace()
    const env = await createEnvironmentFile(ws, 'Producción')

    expect(env.folder).toBe('produccion')
    expect(env.name).toBe('Producción')
    expect(env.id).not.toBe('produccion')
    expect(env.id.length).toBeGreaterThan(0)

    const onDisk = JSON.parse(await fs.readFile(configOf(ws, 'produccion'), 'utf-8'))
    expect(onDisk.name).toBe('Producción')
    expect(onDisk.id).toBe(env.id)
  })

  it('never writes the folder name into config.json (§5.2 — no new field)', async () => {
    const ws = newWorkspace()
    await createEnvironmentFile(ws, 'Staging', { a: '1' })
    const onDisk = JSON.parse(await fs.readFile(configOf(ws, 'staging'), 'utf-8'))
    expect(Object.keys(onDisk).sort()).toEqual(['id', 'name', 'variables'])
  })

  it('rejects a name that derives to nothing, writing nothing (CA-06)', async () => {
    const ws = newWorkspace()
    for (const name of ['本番', '!!!', '   ']) {
      await expect(createEnvironmentFile(ws, name)).rejects.toThrow(/ENVIRONMENT_NAME_EMPTY/)
    }
    // Nothing was written — not even the environments/ directory.
    expect(await fs.readdir(join(ws, 'environments')).catch(() => [])).toEqual([])
  })

  it('rejects a name whose folder is taken, naming the occupying environment (§6.3)', async () => {
    const ws = newWorkspace()
    await seed(ws, 'dev-qa', { id: 'x1', name: 'Dev QA' })
    await expect(createEnvironmentFile(ws, 'Dev / QA')).rejects.toThrow(
      /ENVIRONMENT_NAME_CONFLICT.*Dev QA/s
    )
  })

  it('compares the folder case-insensitively (§6.3, assumption: case-insensitive filesystems)', async () => {
    const ws = newWorkspace()
    await seed(ws, 'Staging', { id: 'x1', name: 'Staging' })
    await expect(createEnvironmentFile(ws, 'STAGING')).rejects.toThrow(/ENVIRONMENT_NAME_CONFLICT/)
  })

  it('never invents a disambiguated folder name (§6.3 — no timestamp fallback)', async () => {
    const ws = newWorkspace()
    await createEnvironmentFile(ws, 'Staging')
    await expect(createEnvironmentFile(ws, 'Staging')).rejects.toThrow(/ENVIRONMENT_NAME_CONFLICT/)
    expect(await fs.readdir(join(ws, 'environments'))).toEqual(['staging'])
  })

  it('caps the folder while keeping the display name at full length (CA-24)', async () => {
    const ws = newWorkspace()
    const typed = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo'

    const env = await createEnvironmentFile(ws, typed)

    expect(env.name).toBe(typed) // display name untruncated
    expect(env.folder.length).toBeLessThanOrEqual(MAX_ENV_FOLDER_NAME)
    expect(env.folder.endsWith('-')).toBe(false) // cut at a whole word
    expect(await fs.readdir(join(ws, 'environments'))).toEqual([env.folder])
  })

  it('allows two different names that derive to different folders', async () => {
    const ws = newWorkspace()
    const a = await createEnvironmentFile(ws, 'Staging')
    const b = await createEnvironmentFile(ws, 'Staging 2')
    expect([a.folder, b.folder]).toEqual(['staging', 'staging-2'])
    expect(a.id).not.toBe(b.id)
  })
})

// ── CA-02 / CA-20 — listing, no migration, hand-renamed folders ─────────────

describe('listEnvironments — folder in hand, no migration (CA-02, CA-20)', () => {
  it('lists a legacy environment verbatim and leaves its config.json byte-identical (CA-02)', async () => {
    const ws = newWorkspace()
    await seed(ws, 'default', { id: 'default', name: 'default', variables: { baseUrl: 'x' } })
    const before = await fs.readFile(configOf(ws, 'default'))

    const envs = await listEnvironments(ws)

    expect(envs).toHaveLength(1)
    expect(envs[0]).toMatchObject({ id: 'default', folder: 'default', name: 'default' })
    expect(await fs.readFile(configOf(ws, 'default'))).toEqual(before)
  })

  it('reads a folder renamed outside the product as it finds it (CA-20)', async () => {
    const ws = newWorkspace()
    await seed(ws, 'staging', { id: 'op4que', name: 'Staging', variables: { a: '1' } })
    // The user renames the folder by hand while the product is closed.
    await fs.rename(join(ws, 'environments', 'staging'), join(ws, 'environments', 'preprod'))

    const envs = await listEnvironments(ws)

    expect(envs).toHaveLength(1)
    expect(envs[0].id).toBe('op4que')
    expect(envs[0].folder).toBe('preprod')
    expect(envs[0].variables).toEqual({ a: '1' })
    // The folder is never renamed back (§6.8).
    expect(await folderExists(ws, 'preprod')).toBe(true)
    expect(await folderExists(ws, 'staging')).toBe(false)
  })

  it('repairs the stored display name when it no longer matches the folder (owner decision Q1)', async () => {
    const ws = newWorkspace()
    await seed(ws, 'staging', { id: 'op4que', name: 'Staging' })
    await fs.rename(join(ws, 'environments', 'staging'), join(ws, 'environments', 'preprod'))

    const envs = await listEnvironments(ws)

    expect(envs[0].name).toBe('preprod')
    const onDisk = JSON.parse(await fs.readFile(configOf(ws, 'preprod'), 'utf-8'))
    expect(onDisk.name).toBe('preprod')
    expect(onDisk.id).toBe('op4que') // the identifier is still never touched
  })

  it('is idempotent — a repaired environment is not rewritten on the next list', async () => {
    const ws = newWorkspace()
    await seed(ws, 'staging', { id: 'op4que', name: 'Staging' })
    await fs.rename(join(ws, 'environments', 'staging'), join(ws, 'environments', 'preprod'))
    await listEnvironments(ws)
    const after = await fs.readFile(configOf(ws, 'preprod'))

    await listEnvironments(ws)

    expect(await fs.readFile(configOf(ws, 'preprod'))).toEqual(after)
  })

  it('does not repair a display name that merely carries characters the folder cannot hold', async () => {
    const ws = newWorkspace()
    await seed(ws, 'produccion', { id: 'x1', name: 'Producción' })
    const before = await fs.readFile(configOf(ws, 'produccion'))

    const envs = await listEnvironments(ws)

    expect(envs[0].name).toBe('Producción')
    expect(await fs.readFile(configOf(ws, 'produccion'))).toEqual(before)
  })

  it('still lists when the repair write fails (best-effort, read-only workspace)', async () => {
    const ws = newWorkspace()
    await seed(ws, 'staging', { id: 'op4que', name: 'Staging' })
    await fs.rename(join(ws, 'environments', 'staging'), join(ws, 'environments', 'preprod'))
    vi.spyOn(fs, 'rename').mockRejectedValue(new Error('EROFS'))
    vi.spyOn(fs, 'writeFile').mockRejectedValue(new Error('EROFS'))

    const envs = await listEnvironments(ws)

    expect(envs[0]).toMatchObject({ id: 'op4que', folder: 'preprod', name: 'preprod' })
  })
})

// ── §6.10 — identifier resolution ───────────────────────────────────────────

describe('resolveEnvFolder (§6.10)', () => {
  it('resolves an opaque id to the folder that holds it', async () => {
    const ws = newWorkspace()
    await seed(ws, 'produccion', { id: 'op4que', name: 'Producción' })
    expect(await resolveEnvFolder(ws, 'op4que')).toBe('produccion')
  })

  it('resolves a legacy id whose folder has the same name', async () => {
    const ws = newWorkspace()
    await seed(ws, 'default', { id: 'default', name: 'default' })
    expect(await resolveEnvFolder(ws, 'default')).toBe('default')
  })

  it('never falls back to treating the identifier as a folder name', async () => {
    const ws = newWorkspace()
    // A folder literally named after the id, but holding a *different* id.
    await seed(ws, 'op4que', { id: 'somethingelse', name: 'op4que' })
    await expect(resolveEnvFolder(ws, 'op4que')).rejects.toMatchObject({
      code: 'ENVIRONMENT_NOT_FOUND'
    })
  })

  it('fails with a distinct not-found naming the identifier', async () => {
    const ws = newWorkspace()
    await seed(ws, 'dev', { id: 'x1', name: 'dev' })
    await expect(resolveEnvFolder(ws, 'ghost')).rejects.toMatchObject({
      code: 'ENVIRONMENT_NOT_FOUND'
    })
    await expect(resolveEnvFolder(ws, 'ghost')).rejects.toThrow(/ghost/)
  })

  it('rejects an identifier shaped like a path escape without touching the filesystem', async () => {
    const ws = newWorkspace()
    await expect(resolveEnvFolder(ws, '../../etc')).rejects.toMatchObject({
      code: 'ENVIRONMENT_NOT_FOUND'
    })
  })
})

describe('resolveEnvFolder — bounded I/O on the send hot path (§11)', () => {
  it('reads exactly one config.json when the id matches its folder (legacy fast path)', async () => {
    const ws = newWorkspace()
    for (let i = 0; i < 40; i++) await seed(ws, `env-${i}`, { id: `env-${i}`, name: `env-${i}` })
    const readFile = vi.spyOn(fs, 'readFile')

    await resolveEnvFolder(ws, 'env-39')

    expect(readFile).toHaveBeenCalledTimes(1)
  })

  it('reads at most one config.json per environment when scanning for an opaque id', async () => {
    const ws = newWorkspace()
    for (let i = 0; i < 40; i++) await seed(ws, `env-${i}`, { id: `op4que-${i}`, name: `env-${i}` })
    const readFile = vi.spyOn(fs, 'readFile')

    await resolveEnvFolder(ws, 'op4que-39')

    expect(readFile.mock.calls.length).toBeLessThanOrEqual(41)
  })
})

// ── CA-03 / CA-07 — rename ──────────────────────────────────────────────────

describe('renameEnvironment (CA-03, CA-07, §6.4, §7.2)', () => {
  it('renames the folder, updates the display name and keeps the identifier (CA-03)', async () => {
    const ws = newWorkspace()
    await seed(ws, 'staging', { id: 'X', name: 'Staging', variables: { a: '1' } })

    const renamed = await renameEnvironment(ws, 'X', 'Producción')

    expect(renamed).toMatchObject({ id: 'X', name: 'Producción', folder: 'produccion' })
    expect(await folderExists(ws, 'staging')).toBe(false)
    const onDisk = JSON.parse(await fs.readFile(configOf(ws, 'produccion'), 'utf-8'))
    expect(onDisk).toEqual({ id: 'X', name: 'Producción', variables: { a: '1' } })
  })

  it('moves the machine-local state with the folder (CA-03)', async () => {
    const ws = newWorkspace()
    await seed(ws, 'staging', { id: 'X', name: 'Staging' })
    const state = join(ws, 'environments', 'staging', '.state')
    await fs.mkdir(state, { recursive: true })
    await fs.writeFile(join(state, 'cookies.json'), '{"cookies":[{"name":"sid"}]}')
    await fs.writeFile(join(state, 'localvalues.json'), '{"version":1,"variables":{"a":"local"}}')

    await renameEnvironment(ws, 'X', 'Producción')

    const moved = join(ws, 'environments', 'produccion', '.state')
    expect(await fs.readFile(join(moved, 'cookies.json'), 'utf-8')).toContain('sid')
    expect(await fs.readFile(join(moved, 'localvalues.json'), 'utf-8')).toContain('local')
  })

  it('accepts a name that derives to the folder it already occupies, updating only the display name (CA-07)', async () => {
    const ws = newWorkspace()
    await seed(ws, 'staging', { id: 'X', name: 'Staging' })

    const renamed = await renameEnvironment(ws, 'X', 'Staging!')

    expect(renamed).toMatchObject({ folder: 'staging', name: 'Staging!' })
    expect(await folderExists(ws, 'staging')).toBe(true)
  })

  it('rejects a colliding name, leaving both folders untouched (CA-05)', async () => {
    const ws = newWorkspace()
    await seed(ws, 'dev-qa', { id: 'A', name: 'Dev QA' })
    await seed(ws, 'staging', { id: 'B', name: 'Staging' })

    await expect(renameEnvironment(ws, 'B', 'Dev QA')).rejects.toThrow(/ENVIRONMENT_NAME_CONFLICT/)

    expect(await folderExists(ws, 'dev-qa')).toBe(true)
    expect(await folderExists(ws, 'staging')).toBe(true)
    const onDisk = JSON.parse(await fs.readFile(configOf(ws, 'staging'), 'utf-8'))
    expect(onDisk.name).toBe('Staging')
  })

  it('rejects a name that derives to nothing, writing nothing', async () => {
    const ws = newWorkspace()
    await seed(ws, 'staging', { id: 'X', name: 'Staging' })
    await expect(renameEnvironment(ws, 'X', '!!!')).rejects.toThrow(/ENVIRONMENT_NAME_EMPTY/)
    const onDisk = JSON.parse(await fs.readFile(configOf(ws, 'staging'), 'utf-8'))
    expect(onDisk.name).toBe('Staging')
  })

  it('does not write the display name when the folder rename fails (§7.2)', async () => {
    const ws = newWorkspace()
    await seed(ws, 'staging', { id: 'X', name: 'Staging' })
    vi.spyOn(fs, 'rename').mockRejectedValue(new Error('EPERM: locked by another process'))

    await expect(renameEnvironment(ws, 'X', 'Producción')).rejects.toThrow(/EPERM/)

    const onDisk = JSON.parse(await fs.readFile(configOf(ws, 'staging'), 'utf-8'))
    expect(onDisk.name).toBe('Staging')
  })

  it('fails with not-found for an identifier no folder holds', async () => {
    const ws = newWorkspace()
    await expect(renameEnvironment(ws, 'ghost', 'X')).rejects.toMatchObject({
      code: 'ENVIRONMENT_NOT_FOUND'
    })
  })

  it('keeps a legacy identifier verbatim (owner decision Q3 — no backfill)', async () => {
    const ws = newWorkspace()
    await seed(ws, 'default', { id: 'default', name: 'default' })

    const renamed = await renameEnvironment(ws, 'default', 'Staging')

    expect(renamed.id).toBe('default')
    expect(renamed.folder).toBe('staging')
  })
})

// ── CA-08 — duplicate ───────────────────────────────────────────────────────

describe('duplicateEnvironment (CA-08, §6.5)', () => {
  it('copies every kind of variable verbatim under a fresh identifier', async () => {
    const ws = newWorkspace()
    await seed(ws, 'staging', {
      id: 'X',
      name: 'Staging',
      variables: { plain: 'v', secret: 'enc:v1:abc', pending: null }
    })

    const copy = await duplicateEnvironment(ws, 'X', 'Staging-copy')

    expect(copy.id).not.toBe('X')
    expect(copy.folder).toBe('staging-copy')
    expect(copy.variables).toEqual({ plain: 'v', secret: 'enc:v1:abc', pending: null })
  })

  it('does not copy the machine-local state (CA-08)', async () => {
    const ws = newWorkspace()
    await seed(ws, 'staging', { id: 'X', name: 'Staging' })
    const state = join(ws, 'environments', 'staging', '.state')
    await fs.mkdir(state, { recursive: true })
    await fs.writeFile(join(state, 'cookies.json'), '{"cookies":[{"name":"sid"}]}')
    await fs.writeFile(join(state, 'localvalues.json'), '{"version":1,"variables":{"a":"local"}}')

    await duplicateEnvironment(ws, 'X', 'Staging-copy')

    expect(await folderExists(ws, join('staging-copy', '.state'))).toBe(false)
    expect(await fs.readdir(join(ws, 'environments', 'staging-copy'))).toEqual(['config.json'])
  })

  it('rejects a colliding copy name, writing nothing', async () => {
    const ws = newWorkspace()
    await seed(ws, 'staging', { id: 'X', name: 'Staging' })
    await seed(ws, 'staging-copy', { id: 'Y', name: 'Staging-copy' })

    await expect(duplicateEnvironment(ws, 'X', 'Staging copy')).rejects.toThrow(
      /ENVIRONMENT_NAME_CONFLICT/
    )
    expect((await fs.readdir(join(ws, 'environments'))).sort()).toEqual(['staging', 'staging-copy'])
  })

  it('fails with not-found for a source identifier no folder holds', async () => {
    const ws = newWorkspace()
    await expect(duplicateEnvironment(ws, 'ghost', 'X')).rejects.toMatchObject({
      code: 'ENVIRONMENT_NOT_FOUND'
    })
  })
})

// ── delete / write — resolution instead of id-as-path ────────────────────────

describe('deleteEnvironment resolves the identifier (§6.10)', () => {
  it('removes the folder that holds the identifier, not a folder named after it', async () => {
    const ws = newWorkspace()
    await seed(ws, 'produccion', { id: 'op4que', name: 'Producción' })
    await seed(ws, 'op4que', { id: 'decoy', name: 'op4que' })

    await deleteEnvironment(ws, 'op4que')

    expect(await folderExists(ws, 'produccion')).toBe(false)
    expect(await folderExists(ws, 'op4que')).toBe(true)
  })

  it('surfaces a not-found rather than silently doing nothing', async () => {
    const ws = newWorkspace()
    await expect(deleteEnvironment(ws, 'ghost')).rejects.toMatchObject({
      code: 'ENVIRONMENT_NOT_FOUND'
    })
  })
})

describe('writeEnvFile — folder-keyed, never identifier-keyed (§9.2 op-check 2)', () => {
  it('writes into the environment folder, ignoring the identifier', async () => {
    const ws = newWorkspace()
    await writeEnvFile(ws, {
      id: 'op4que',
      name: 'Producción',
      folder: 'produccion',
      variables: { a: '1' }
    })
    const back = await readEnvFile(configOf(ws, 'produccion'))
    expect(back).toEqual({
      id: 'op4que',
      name: 'Producción',
      folder: 'produccion',
      variables: { a: '1' }
    })
    expect(await folderExists(ws, 'op4que')).toBe(false)
  })

  it('rejects a folder that escapes the workspace', async () => {
    const ws = newWorkspace()
    await expect(
      writeEnvFile(ws, {
        id: 'x',
        name: 'legit',
        folder: '../../../../../../tmp/fp-evil',
        variables: {}
      })
    ).rejects.toThrow(/Unsafe|escapes workspace/i)
  })
})

// ── CA-19 / §6.10 — the state addressed by an identifier follows the folder ──

describe('machine-local state resolves through the identifier (CA-19, §6.10)', () => {
  it('writes the cookie jar inside the folder that holds the identifier', async () => {
    const ws = newWorkspace()
    await seed(ws, 'produccion', { id: 'op4que', name: 'Producción' })
    // A decoy folder literally named after the identifier: a path built from the
    // id instead of the resolved folder would land here.
    await seed(ws, 'op4que', { id: 'decoy', name: 'op4que' })

    await captureFromResponse(ws, 'op4que', 'https://api.example.com/login', ['sid=abc; Path=/'])

    const jar = join(ws, 'environments', 'produccion', '.state', 'cookies.json')
    expect(JSON.parse(await fs.readFile(jar, 'utf-8')).cookies[0].name).toBe('sid')
    expect(await folderExists(ws, join('op4que', '.state'))).toBe(false)
  })

  it('attaches and captures cookies at the new location after a rename (CA-19)', async () => {
    const ws = newWorkspace()
    await seed(ws, 'staging', { id: 'X', name: 'Staging' })
    await captureFromResponse(ws, 'X', 'https://api.example.com/login', ['sid=abc; Path=/'])

    await renameEnvironment(ws, 'X', 'Producción')

    // Same identifier, new folder — the jar moved with it and still matches.
    const matching = await getMatchingCookies(ws, 'X', 'https://api.example.com/orders')
    expect(matching.map((c) => c.name)).toEqual(['sid'])

    await captureFromResponse(ws, 'X', 'https://api.example.com/orders', ['tid=def; Path=/'])
    const jar = join(ws, 'environments', 'produccion', '.state', 'cookies.json')
    const names = JSON.parse(await fs.readFile(jar, 'utf-8')).cookies.map(
      (c: { name: string }) => c.name
    )
    expect(names.sort()).toEqual(['sid', 'tid'])
    expect(await folderExists(ws, 'staging')).toBe(false)
  })

  it('keeps the local value overrides addressable across a rename', async () => {
    const ws = newWorkspace()
    await seed(ws, 'staging', { id: 'X', name: 'Staging' })
    await writeLocalValues(ws, 'X', { version: 1, variables: { baseUrl: 'http://localhost' } })

    await renameEnvironment(ws, 'X', 'Producción')

    expect((await readLocalValues(ws, 'X')).variables).toEqual({
      baseUrl: 'http://localhost'
    })
    await expect(
      fs.access(join(ws, 'environments', 'produccion', '.state', 'localvalues.json'))
    ).resolves.toBeUndefined()
  })

  it('refuses to write the jar when the folder was renamed away mid-operation (§11)', async () => {
    const ws = newWorkspace()
    await seed(ws, 'staging', { id: 'X', name: 'Staging' })
    await captureFromResponse(ws, 'X', 'https://api.example.com/a', ['sid=abc; Path=/'])
    // The environment disappears between operations.
    await fs.rm(join(ws, 'environments', 'staging'), { recursive: true, force: true })

    await expect(
      captureFromResponse(ws, 'X', 'https://api.example.com/b', ['tid=def; Path=/'])
    ).rejects.toMatchObject({ code: 'ENVIRONMENT_NOT_FOUND' })

    // The path was never recreated behind the user's back.
    expect(await folderExists(ws, 'staging')).toBe(false)
  })
})
