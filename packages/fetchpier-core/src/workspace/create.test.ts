import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspace } from './create'
import { CoreError } from '../shared/context'

async function read(path: string): Promise<string> {
  return fs.readFile(path, 'utf-8')
}
async function exists(path: string): Promise<boolean> {
  return fs
    .access(path)
    .then(() => true)
    .catch(() => false)
}

describe('createWorkspace', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'core-ws-'))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates the standard workspace layout (seed excludes .fetchpier/, includes .env — REQ-0067 CA-09)', async () => {
    const result = await createWorkspace(dir)
    expect(JSON.parse(await read(join(dir, '.fetchpier', 'settings.json')))).toEqual({ version: 1 })
    expect(await exists(join(dir, 'environments'))).toBe(true)
    expect(await exists(join(dir, 'requests', '.runs'))).toBe(true)
    const gitignore = await read(join(dir, '.gitignore'))
    // `.fetchpier/` is workspace-shared config (like `.vscode/`) and must NOT be ignored.
    expect(gitignore).not.toContain('.fetchpier/')
    expect(gitignore).toContain('**/.state/')
    expect(gitignore).toContain('**/.runs/')
    expect(gitignore).toContain('.env')
    expect(result.gitignoreCreated).toBe(true)
  })

  it('does not seed a default environment unless asked', async () => {
    await createWorkspace(dir)
    expect(await exists(join(dir, 'environments', 'default', 'config.json'))).toBe(false)
  })

  // REQ-0121 CA-01/CA-02: one seed, owned by core, for both adapters.
  it('seeds the Default environment when requested', async () => {
    await createWorkspace(dir, { seedDefaultEnvironment: true })
    // Display name `Default`, folder `default`: the capitalized form is what the
    // selector shows, the lowercase folder is the handle a pipeline passes to
    // --env (matched case-insensitively, so one seed serves both).
    const cfg = JSON.parse(await read(join(dir, 'environments', 'default', 'config.json')))
    expect(cfg.name).toBe('Default')
    expect(cfg.variables).toEqual({ baseUrl: 'https://example.com' })
    expect(Object.keys(cfg).sort()).toEqual(['id', 'name', 'variables'])
    // The identifier is opaque and generated: nothing derives the folder from it,
    // and no adapter hand-writes the literal string `default` any more.
    expect(cfg.id).not.toBe('default')
    expect(cfg.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/)
  })

  // REQ-0121 CA-03: the selection is recorded, not merely derived. Without this
  // file the desktop falls back to "first environment in the list", which is
  // folder ordering rather than intent once a second environment exists.
  it('records the seeded environment as the active selection', async () => {
    await createWorkspace(dir, { seedDefaultEnvironment: true })
    const envCfg = JSON.parse(await read(join(dir, 'environments', 'default', 'config.json')))
    const state = JSON.parse(await read(join(dir, '.fetchpier', '.state', 'workspace-state.json')))
    expect(state.activeEnvironmentId).toBe(envCfg.id)
    // Shape the desktop's reader expects: a just-created workspace has no tabs.
    expect(state.schemaVersion).toBe(1)
    expect(state.session).toEqual({ tabs: [], activeTabIndex: -1 })
  })

  it('writes no workspace state when the environment seed is not requested', async () => {
    await createWorkspace(dir)
    expect(await exists(join(dir, '.fetchpier', '.state', 'workspace-state.json'))).toBe(false)
  })

  // The state is personal and may already hold a session; the seed is not a
  // reason to lose it.
  it('never overwrites an existing workspace state', async () => {
    await fs.mkdir(join(dir, '.fetchpier', '.state'), { recursive: true })
    const kept = JSON.stringify({
      schemaVersion: 1,
      activeEnvironmentId: 'chosen-by-the-user',
      session: { tabs: [], activeTabIndex: -1 }
    })
    await fs.writeFile(join(dir, '.fetchpier', '.state', 'workspace-state.json'), kept, 'utf-8')

    await createWorkspace(dir, { seedDefaultEnvironment: true })

    const state = JSON.parse(await read(join(dir, '.fetchpier', '.state', 'workspace-state.json')))
    expect(state.activeEnvironmentId).toBe('chosen-by-the-user')
  })

  // REQ-0121 CA-06: creating over a folder that already holds the environment
  // preserves it — the seed never overwrites what the user brought with them.
  it('preserves an existing default environment instead of overwriting it', async () => {
    await fs.mkdir(join(dir, 'environments', 'default'), { recursive: true })
    const kept = JSON.stringify({
      id: 'legacy-id',
      name: 'default',
      variables: { baseUrl: 'https://kept.example' }
    })
    await fs.writeFile(join(dir, 'environments', 'default', 'config.json'), kept, 'utf-8')

    await createWorkspace(dir, { seedDefaultEnvironment: true })

    const cfg = JSON.parse(await read(join(dir, 'environments', 'default', 'config.json')))
    expect(cfg.id).toBe('legacy-id')
    expect(cfg.variables.baseUrl).toBe('https://kept.example')
    // Nothing was seeded, so nothing selects: the state follows the environment.
    expect(await exists(join(dir, '.fetchpier', '.state', 'workspace-state.json'))).toBe(false)
  })

  // REQ-0121 CA-07: on a case-sensitive filesystem a hand-created `Default/` would
  // slip past a path check and then be rejected as a naming conflict — which,
  // thrown from the seed, would abort workspace creation outright. It must skip.
  it('skips — never throws — when a case-variant folder occupies the name', async () => {
    await fs.mkdir(join(dir, 'environments', 'Default'), { recursive: true })
    await fs.writeFile(
      join(dir, 'environments', 'Default', 'config.json'),
      JSON.stringify({ id: 'cased', name: 'Default', variables: {} }),
      'utf-8'
    )

    await expect(createWorkspace(dir, { seedDefaultEnvironment: true })).resolves.toHaveProperty(
      'gitignoreCreated'
    )

    const folders = await fs.readdir(join(dir, 'environments'))
    expect(folders).toEqual(['Default'])
    expect(await exists(join(dir, '.fetchpier', '.state', 'workspace-state.json'))).toBe(false)
  })

  it('owner-respects an existing .gitignore: never modifies it (REQ-0067 §6.5 / CA-11)', async () => {
    await fs.mkdir(dir, { recursive: true })
    const customContent = 'custom-entry\nnode_modules/\n'
    await fs.writeFile(join(dir, '.gitignore'), customContent, 'utf-8')
    const result = await createWorkspace(dir)
    expect(result.gitignoreCreated).toBe(false)
    const gi = await read(join(dir, '.gitignore'))
    expect(gi).toBe(customContent)
    expect(gi).not.toContain('.fetchpier/')
    expect(gi).not.toContain('.env')
  })

  it('owner-respects an empty .gitignore (existence is the user flag)', async () => {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, '.gitignore'), '', 'utf-8')
    const result = await createWorkspace(dir)
    expect(result.gitignoreCreated).toBe(false)
    const gi = await read(join(dir, '.gitignore'))
    expect(gi).toBe('')
  })

  it('preserves existing .fetchpier/settings.json across repeat calls', async () => {
    await createWorkspace(dir)
    await fs.writeFile(
      join(dir, '.fetchpier', 'settings.json'),
      JSON.stringify({ version: 1, http: { verifySsl: false } })
    )
    await createWorkspace(dir)
    expect(JSON.parse(await read(join(dir, '.fetchpier', 'settings.json')))).toEqual({
      version: 1,
      http: { verifySsl: false }
    })
  })

  it('reports gitignoreCreated=false on repeat calls (once seeded, never re-seeded)', async () => {
    const first = await createWorkspace(dir)
    expect(first.gitignoreCreated).toBe(true)
    const second = await createWorkspace(dir)
    expect(second.gitignoreCreated).toBe(false)
    const third = await createWorkspace(dir)
    expect(third.gitignoreCreated).toBe(false)
  })

  it('regenerates .gitignore if it is missing on a subsequent call (CA-10 — defensive seed)', async () => {
    await createWorkspace(dir)
    await fs.unlink(join(dir, '.gitignore'))
    const result = await createWorkspace(dir)
    expect(result.gitignoreCreated).toBe(true)
    const gi = await read(join(dir, '.gitignore'))
    expect(gi).toContain('.env')
  })

  it('throws WORKSPACE_INVALID when the path is a file', async () => {
    const file = join(dir, 'afile')
    await fs.writeFile(file, 'x')
    await expect(createWorkspace(file)).rejects.toBeInstanceOf(CoreError)
  })

  // Atomic writes — closing the write-safety coverage gap: these three seeds
  // used to do a direct fs.writeFile with no temp file at all — a crash
  // mid-write would leave a truncated seed the existence guard then treats as
  // "already there" forever.
  it('retries the rename through a transient error and still seeds .gitignore (CA-06)', async () => {
    const transient = Object.assign(new Error('EBUSY: resource busy or locked, rename'), {
      code: 'EBUSY'
    })
    const realRename = fs.rename.bind(fs)
    let thrown = false
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith('.gitignore') && !thrown) {
        thrown = true
        throw transient
      }
      return realRename(from, to)
    })

    const result = await createWorkspace(dir)

    expect(thrown).toBe(true)
    renameSpy.mockRestore()
    expect(result.gitignoreCreated).toBe(true)
    expect(await read(join(dir, '.gitignore'))).toContain('.env')
  })

  it('leaves no partial seed when the write is interrupted (CA-06)', async () => {
    const renameSpy = vi
      .spyOn(fs, 'rename')
      .mockRejectedValueOnce(new Error('ENOSPC: simulated disk full'))

    await expect(createWorkspace(dir)).rejects.toThrow(/ENOSPC/)
    renameSpy.mockRestore()

    // The first seed write (settings.json) failed — no half-written file, no
    // stray temp file, and later seeds (.gitignore) never ran.
    expect(await exists(join(dir, '.fetchpier', 'settings.json'))).toBe(false)
    const fetchpierDir = await fs.readdir(join(dir, '.fetchpier'))
    expect(fetchpierDir).toEqual([])
  })
})
