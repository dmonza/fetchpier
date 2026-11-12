import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, promises as fs, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  _resetForTests,
  clearWorkspace,
  deleteForRequest,
  flushSync,
  getAll,
  getForRequest,
  loadFromWorkspace,
  setForRequest
} from './ui-state-store'

const FILE_REL = join('requests', '.state', 'ui-state.json')

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(path, 'utf-8'))
}

function writeRequestFile(workspace: string, relPath: string, requestId: string | null): void {
  const full = join(workspace, 'requests', relPath)
  const dir = join(full, '..')
  // sync create
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdirSync, writeFileSync } = require('node:fs') as typeof import('node:fs')
  mkdirSync(dir, { recursive: true })
  const body = [requestId ? `# @id ${requestId}` : '', 'GET https://example.com/']
    .filter(Boolean)
    .join('\n')
  writeFileSync(full, body, 'utf-8')
}

describe('ui-state-store', () => {
  let ws: string

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'ui-state-'))
    _resetForTests()
  })

  afterEach(() => {
    _resetForTests()
    rmSync(ws, { recursive: true, force: true })
  })

  it('returns null and an empty map when no workspace is active', () => {
    expect(getForRequest('x')).toBeNull()
    expect(getAll()).toEqual({})
  })

  it('round-trips read/write via flushSync', async () => {
    await loadFromWorkspace(ws)
    const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    writeRequestFile(ws, 'a.http', id) // keep entry alive past GC checks
    await loadFromWorkspace(ws)
    setForRequest(id, { activeReqTab: 'body' })
    flushSync()

    const onDisk = (await readJson(join(ws, FILE_REL))) as Record<string, unknown>
    expect(onDisk[id]).toEqual({ activeReqTab: 'body' })
  })

  it('merges partial writes into the existing entry', async () => {
    const id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    writeRequestFile(ws, 'b.http', id)
    await loadFromWorkspace(ws)

    setForRequest(id, { activeReqTab: 'body' })
    setForRequest(id, { activeResponseTab: 'tests' })
    setForRequest(id, { activeScriptPhase: 'post' })
    flushSync()

    expect(getForRequest(id)).toEqual({
      activeReqTab: 'body',
      activeResponseTab: 'tests',
      activeScriptPhase: 'post'
    })
  })

  it('persists the Security response tab', async () => {
    const id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
    writeRequestFile(ws, 'e.http', id)
    await loadFromWorkspace(ws)

    setForRequest(id, { activeResponseTab: 'security' })
    flushSync()

    const onDisk = (await readJson(join(ws, FILE_REL))) as Record<string, unknown>
    expect(onDisk[id]).toEqual({ activeResponseTab: 'security' })
  })

  it('drops invalid enum values with a console.warn', async () => {
    const id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
    writeRequestFile(ws, 'c.http', id)
    await loadFromWorkspace(ws)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setForRequest(id, {
      activeReqTab: 'garbage' as never,
      activeResponseTab: 'tests',
      activeScriptPhase: 'tomorrow' as never
    })
    // Only the valid field survived
    expect(getForRequest(id)).toEqual({ activeResponseTab: 'tests' })
    // Two warns: one for activeReqTab, one for activeScriptPhase
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('writes are atomic — uses a .tmp file + rename', async () => {
    const id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
    writeRequestFile(ws, 'd.http', id)
    await loadFromWorkspace(ws)
    setForRequest(id, { activeReqTab: 'body' })
    flushSync()

    const stateDir = join(ws, 'requests', '.state')
    const entries = await fs.readdir(stateDir)
    // After a successful flush, only the final file should be present (no leftover .tmp)
    expect(entries).toContain('ui-state.json')
    expect(entries.every((e) => !e.endsWith('.tmp'))).toBe(true)
  })

  it('GCs entries whose UUID is no longer present in any .http', async () => {
    const present = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
    const orphan = 'ffffffff-ffff-ffff-ffff-ffffffffffff'

    writeRequestFile(ws, 'present.http', present)
    // Seed file directly with both entries
    await fs.mkdir(join(ws, 'requests', '.state'), { recursive: true })
    await fs.writeFile(
      join(ws, FILE_REL),
      JSON.stringify({
        [present]: { activeReqTab: 'body' },
        [orphan]: { activeReqTab: 'headers' }
      }),
      'utf-8'
    )

    await loadFromWorkspace(ws)
    expect(getForRequest(present)).toEqual({ activeReqTab: 'body' })
    expect(getForRequest(orphan)).toBeNull()

    // The GC scheduled a write — flush it and re-read from disk.
    flushSync()
    const onDisk = (await readJson(join(ws, FILE_REL))) as Record<string, unknown>
    expect(onDisk).toEqual({ [present]: { activeReqTab: 'body' } })
  })

  it('flushSync is a no-op when no write is pending', async () => {
    await loadFromWorkspace(ws)
    flushSync()
    await expect(fs.access(join(ws, FILE_REL))).rejects.toBeTruthy()
  })

  it('flushSync writes pending state synchronously (before-quit semantics)', async () => {
    const id = '11111111-1111-1111-1111-111111111111'
    writeRequestFile(ws, 'x.http', id)
    await loadFromWorkspace(ws)
    setForRequest(id, { activeReqTab: 'auth' })
    // Without awaiting any debounce, flushSync must persist the in-memory state.
    flushSync()
    const onDisk = JSON.parse(readFileSync(join(ws, FILE_REL), 'utf-8'))
    expect(onDisk[id]).toEqual({ activeReqTab: 'auth' })
  })

  it('switching workspaces flushes pending state of the previous one', async () => {
    const a = mkdtempSync(join(tmpdir(), 'ui-state-a-'))
    const b = mkdtempSync(join(tmpdir(), 'ui-state-b-'))
    try {
      const idA = '22222222-2222-2222-2222-222222222222'
      writeRequestFile(a, 'a.http', idA)
      await loadFromWorkspace(a)
      setForRequest(idA, { activeReqTab: 'body' })

      // Switching workspaces should flushSync the pending write to `a`.
      await loadFromWorkspace(b)
      const onDiskA = JSON.parse(readFileSync(join(a, FILE_REL), 'utf-8'))
      expect(onDiskA[idA]).toEqual({ activeReqTab: 'body' })

      // And the in-memory state is now `b`'s.
      expect(getForRequest(idA)).toBeNull()
    } finally {
      rmSync(a, { recursive: true, force: true })
      rmSync(b, { recursive: true, force: true })
    }
  })

  it('reloading the open workspace keeps a change still waiting for its debounced write (HIS-05)', async () => {
    const id = '44444444-4444-4444-4444-444444444444'
    writeRequestFile(ws, 'r.http', id)
    await loadFromWorkspace(ws)
    setForRequest(id, { activeReqTab: 'body' })

    await loadFromWorkspace(ws)
    expect(getForRequest(id)).toEqual({ activeReqTab: 'body' })
    flushSync()
    const onDisk = JSON.parse(readFileSync(join(ws, FILE_REL), 'utf-8'))
    expect(onDisk[id]).toEqual({ activeReqTab: 'body' })
  })

  it('clearWorkspace flushes pending writes then detaches', async () => {
    const id = '33333333-3333-3333-3333-333333333333'
    writeRequestFile(ws, 'k.http', id)
    await loadFromWorkspace(ws)
    setForRequest(id, { activeReqTab: 'body' })

    clearWorkspace()
    const onDisk = JSON.parse(readFileSync(join(ws, FILE_REL), 'utf-8'))
    expect(onDisk[id]).toEqual({ activeReqTab: 'body' })

    // After clear, no workspace is active.
    expect(getForRequest(id)).toBeNull()
  })

  it('deleteForRequest removes the entry and persists the removal', async () => {
    const id = '44444444-4444-4444-4444-444444444444'
    writeRequestFile(ws, 'd2.http', id)
    await loadFromWorkspace(ws)
    setForRequest(id, { activeReqTab: 'body' })
    flushSync()
    expect(getForRequest(id)).not.toBeNull()

    deleteForRequest(id)
    flushSync()
    expect(getForRequest(id)).toBeNull()
    const onDisk = JSON.parse(readFileSync(join(ws, FILE_REL), 'utf-8'))
    expect(onDisk[id]).toBeUndefined()
  })

  it('tolerates a malformed on-disk file (returns empty map)', async () => {
    await fs.mkdir(join(ws, 'requests', '.state'), { recursive: true })
    await fs.writeFile(join(ws, FILE_REL), '{ not valid json', 'utf-8')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await loadFromWorkspace(ws)
    expect(getAll()).toEqual({})
    warn.mockRestore()
  })

  it('drops entries with invalid enum values when loading from disk', async () => {
    const id = '55555555-5555-5555-5555-555555555555'
    writeRequestFile(ws, 'invalid.http', id)
    await fs.mkdir(join(ws, 'requests', '.state'), { recursive: true })
    await fs.writeFile(
      join(ws, FILE_REL),
      JSON.stringify({
        [id]: { activeReqTab: 'garbage', activeResponseTab: 'tests' }
      }),
      'utf-8'
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await loadFromWorkspace(ws)
    expect(getForRequest(id)).toEqual({ activeResponseTab: 'tests' })
    warn.mockRestore()
  })
})
