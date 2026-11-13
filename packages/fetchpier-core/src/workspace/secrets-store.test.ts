import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildManifest, generateWorkspaceKey } from '../secrets'
import { readManifest, secretsManifestPath, writeManifest } from './secrets-store'

describe('readManifest / writeManifest', () => {
  let ws = ''

  beforeEach(async () => {
    ws = await fs.mkdtemp(join(tmpdir(), 'secrets-store-test-'))
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(ws, { recursive: true, force: true })
  })

  it('returns null when no manifest exists', async () => {
    expect(await readManifest(ws)).toBeNull()
  })

  it('returns null when `.fetchpier` is a file (no manifest can exist there)', async () => {
    await fs.writeFile(join(ws, '.fetchpier'), 'not a folder')
    expect(await readManifest(ws)).toBeNull()
  })

  // SEC-13: only a missing file means "no secrets"; a present manifest that
  // cannot be read is an error, never a workspace that uses no key.
  it('throws WORKSPACE_INVALID when the manifest exists but cannot be read', async () => {
    await fs.mkdir(secretsManifestPath(ws), { recursive: true }) // EISDIR
    await expect(readManifest(ws)).rejects.toMatchObject({
      code: 'WORKSPACE_INVALID',
      message: expect.stringContaining('secrets.json')
    })
  })

  it.each(['EACCES', 'EPERM', 'EBUSY', 'EIO'])('throws on a %s read error', async (code) => {
    vi.spyOn(fs, 'readFile').mockRejectedValueOnce(
      Object.assign(new Error(`${code}: simulated`), { code })
    )
    await expect(readManifest(ws)).rejects.toMatchObject({ code: 'WORKSPACE_INVALID' })
  })

  it('round-trips a manifest', async () => {
    const key = await generateWorkspaceKey()
    const manifest = await buildManifest(key)
    await writeManifest(ws, manifest)
    const back = await readManifest(ws)
    expect(back).toEqual(manifest)
  })

  // Atomic writes — closing the write-safety coverage gap: this writer used to
  // hand-roll its own temp+rename (missing the shared helper's Windows retry).
  it('retries the rename through a transient error and eventually succeeds (CA-01)', async () => {
    const key = await generateWorkspaceKey()
    const manifest = await buildManifest(key)
    await writeManifest(ws, manifest)

    const key2 = await generateWorkspaceKey()
    const manifest2 = await buildManifest(key2)
    const transient = Object.assign(new Error('EBUSY: resource busy or locked, rename'), {
      code: 'EBUSY'
    })
    const renameSpy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(transient)

    await writeManifest(ws, manifest2)

    expect(renameSpy).toHaveBeenCalledTimes(2)
    expect(await readManifest(ws)).toEqual(manifest2)
  })

  it('leaves the previous manifest intact when the write is interrupted (CA-02)', async () => {
    const key = await generateWorkspaceKey()
    const manifest = await buildManifest(key)
    await writeManifest(ws, manifest)

    const key2 = await generateWorkspaceKey()
    const manifest2 = await buildManifest(key2)
    const renameSpy = vi
      .spyOn(fs, 'rename')
      .mockRejectedValueOnce(new Error('ENOSPC: simulated disk full'))

    await expect(writeManifest(ws, manifest2)).rejects.toThrow(/ENOSPC/)
    renameSpy.mockRestore()

    expect(await readManifest(ws)).toEqual(manifest)
    const siblings = await fs.readdir(join(ws, '.fetchpier'))
    expect(siblings).toEqual(['secrets.json'])
  })

  it('exposes the manifest path helper', () => {
    expect(secretsManifestPath(ws)).toBe(join(ws, '.fetchpier', 'secrets.json'))
  })
})
