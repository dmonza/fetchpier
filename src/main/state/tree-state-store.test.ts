import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, promises as fs, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  _resetForTests,
  clearWorkspace,
  flushSync,
  getAll,
  loadFromWorkspace,
  setExpanded
} from './tree-state-store'

const FILE_REL = join('requests', '.state', 'tree-state.json')

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(path, 'utf-8'))
}

describe('tree-state-store', () => {
  let ws: string

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'tree-state-'))
    _resetForTests()
  })

  afterEach(() => {
    _resetForTests()
    rmSync(ws, { recursive: true, force: true })
  })

  it('returns null when no workspace is active', () => {
    expect(getAll()).toBeNull()
  })

  it('returns null when the file does not exist (first run)', async () => {
    await loadFromWorkspace(ws)
    expect(getAll()).toBeNull()
  })

  it('returns an array (including empty) when the file exists', async () => {
    await fs.mkdir(join(ws, 'requests', '.state'), { recursive: true })
    await fs.writeFile(join(ws, FILE_REL), JSON.stringify([]), 'utf-8')
    await loadFromWorkspace(ws)
    expect(getAll()).toEqual([])
  })

  it('round-trips set/read via flushSync', async () => {
    await loadFromWorkspace(ws)
    setExpanded(['a', 'a/b'])
    flushSync()

    expect(await readJson(join(ws, FILE_REL))).toEqual(['a', 'a/b'])
    expect(getAll()).toEqual(['a', 'a/b'])
  })

  it('sanitizes: normalizes backslashes, dedups, drops non-strings and blanks', async () => {
    await loadFromWorkspace(ws)
    setExpanded(['a\\b', 'a/b', '', '  ', 42, null, 'c'] as unknown[])
    expect(getAll()).toEqual(['a/b', 'c'])
  })

  it('setExpanded replaces the whole set', async () => {
    await loadFromWorkspace(ws)
    setExpanded(['a', 'b'])
    setExpanded(['c'])
    expect(getAll()).toEqual(['c'])
  })

  it('writes are atomic — no leftover .tmp after flush', async () => {
    await loadFromWorkspace(ws)
    setExpanded(['a'])
    flushSync()
    const entries = await fs.readdir(join(ws, 'requests', '.state'))
    expect(entries).toContain('tree-state.json')
    expect(entries.every((e) => !e.endsWith('.tmp'))).toBe(true)
  })

  it('flushSync is a no-op when no write is pending', async () => {
    await loadFromWorkspace(ws)
    flushSync()
    await expect(fs.access(join(ws, FILE_REL))).rejects.toBeTruthy()
  })

  it('flushSync persists pending state synchronously (before-quit semantics)', async () => {
    await loadFromWorkspace(ws)
    setExpanded(['x'])
    flushSync()
    expect(JSON.parse(readFileSync(join(ws, FILE_REL), 'utf-8'))).toEqual(['x'])
  })

  it('switching workspaces flushes pending state of the previous one', async () => {
    const a = mkdtempSync(join(tmpdir(), 'tree-state-a-'))
    const b = mkdtempSync(join(tmpdir(), 'tree-state-b-'))
    try {
      await loadFromWorkspace(a)
      setExpanded(['a-folder'])
      await loadFromWorkspace(b)
      expect(JSON.parse(readFileSync(join(a, FILE_REL), 'utf-8'))).toEqual(['a-folder'])
      // Now detached from a: b's file does not exist yet.
      expect(getAll()).toBeNull()
    } finally {
      rmSync(a, { recursive: true, force: true })
      rmSync(b, { recursive: true, force: true })
    }
  })

  it('clearWorkspace flushes pending writes then detaches', async () => {
    await loadFromWorkspace(ws)
    setExpanded(['k'])
    clearWorkspace()
    expect(JSON.parse(readFileSync(join(ws, FILE_REL), 'utf-8'))).toEqual(['k'])
    expect(getAll()).toBeNull()
  })

  it('after a write, getAll returns the array instead of null', async () => {
    await loadFromWorkspace(ws)
    expect(getAll()).toBeNull()
    setExpanded(['a'])
    expect(getAll()).toEqual(['a'])
  })

  it('tolerates a malformed on-disk file (treated as first run → null)', async () => {
    await fs.mkdir(join(ws, 'requests', '.state'), { recursive: true })
    await fs.writeFile(join(ws, FILE_REL), '{ not valid json', 'utf-8')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await loadFromWorkspace(ws)
    expect(getAll()).toBeNull()
    warn.mockRestore()
  })
})
