/**
 * Machine-local last-opened-workspace pointer + MRU list persistence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let userDataDir: string

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir }
}))

import {
  getRecentWorkspacePaths,
  readWorkspaceStore,
  writeWorkspaceStore
} from './recent-workspaces'

beforeEach(async () => {
  userDataDir = await fs.mkdtemp(join(tmpdir(), 'fp-recent-workspaces-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(userDataDir, { recursive: true, force: true })
})

describe('readWorkspaceStore / writeWorkspaceStore', () => {
  it('returns an empty store when no file exists', async () => {
    expect(await readWorkspaceStore()).toEqual({ path: '', recent: [] })
  })

  it('round-trips the last-opened path and recent list', async () => {
    await writeWorkspaceStore({ path: '/ws/a', recent: ['/ws/a', '/ws/b'] })
    expect(await readWorkspaceStore()).toEqual({ path: '/ws/a', recent: ['/ws/a', '/ws/b'] })
  })

  it('degrades to an empty store on corrupt JSON', async () => {
    await fs.mkdir(userDataDir, { recursive: true })
    await fs.writeFile(join(userDataDir, 'last-workspace.json'), '{ not json', 'utf-8')
    expect(await readWorkspaceStore()).toEqual({ path: '', recent: [] })
  })

  // Atomic writes — closing the write-safety coverage gap: this writer used to
  // do a direct fs.writeFile with no temp file at all.
  it('retries the write through a transient rename error and eventually succeeds (CA-01)', async () => {
    await writeWorkspaceStore({ path: '/ws/a', recent: ['/ws/a'] })
    const transient = Object.assign(new Error('EBUSY: resource busy or locked, rename'), {
      code: 'EBUSY'
    })
    const renameSpy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(transient)

    await writeWorkspaceStore({ path: '/ws/b', recent: ['/ws/b', '/ws/a'] })

    expect(renameSpy).toHaveBeenCalledTimes(2)
    expect(await readWorkspaceStore()).toEqual({ path: '/ws/b', recent: ['/ws/b', '/ws/a'] })
  })

  it('leaves the previous store intact when the write is interrupted (CA-03)', async () => {
    await writeWorkspaceStore({ path: '/ws/a', recent: ['/ws/a'] })
    const renameSpy = vi
      .spyOn(fs, 'rename')
      .mockRejectedValueOnce(new Error('ENOSPC: simulated disk full'))

    await expect(writeWorkspaceStore({ path: '/ws/b', recent: ['/ws/b'] })).rejects.toThrow(
      /ENOSPC/
    )
    renameSpy.mockRestore()

    expect(await readWorkspaceStore()).toEqual({ path: '/ws/a', recent: ['/ws/a'] })
    const siblings = await fs.readdir(userDataDir)
    expect(siblings).toEqual(['last-workspace.json'])
  })
})

describe('getRecentWorkspacePaths', () => {
  it('returns the recent list unfiltered', async () => {
    await writeWorkspaceStore({ path: '/ws/a', recent: ['/ws/a', '/does/not/exist'] })
    expect(await getRecentWorkspacePaths()).toEqual(['/ws/a', '/does/not/exist'])
  })
})
