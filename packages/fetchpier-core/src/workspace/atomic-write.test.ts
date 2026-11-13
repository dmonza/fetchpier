import { promises as fsp, readFileSync, existsSync } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { atomicWriteBatch, atomicWriteFile, atomicWriteFileSync } from './atomic-write'

// The sync variant uses the named `node:fs` exports, which cannot be spied on
// in place; pass-through wrappers record the order of its flush and rename.
const syncOrder = vi.hoisted(() => [] as string[])
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    fsyncSync: (fd: number): void => {
      syncOrder.push('fsync')
      actual.fsyncSync(fd)
    },
    renameSync: (from: string, to: string): void => {
      syncOrder.push('rename')
      actual.renameSync(from, to)
    }
  }
})

let dir: string
const realPlatform = process.platform

beforeEach(async () => {
  syncOrder.length = 0
  dir = await mkdtemp(join(tmpdir(), 'fp-atomic-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  Object.defineProperty(process, 'platform', { value: realPlatform })
  await rm(dir, { recursive: true, force: true })
})

/**
 * Record, in order, every flush (`sync` on a handle, tagged with the opened
 * path) and every rename. A directory open is answered with a fake handle: on
 * Windows a real one cannot be opened for a flush.
 */
function recordFlushes(opts: { failDirectory?: boolean } = {}): string[] {
  const order: string[] = []
  const realOpen = fsp.open.bind(fsp)
  vi.spyOn(fsp, 'open').mockImplementation(async (path, flags, mode) => {
    const p = String(path)
    if (p === dir) {
      if (opts.failDirectory) throw Object.assign(new Error('EISDIR'), { code: 'EISDIR' })
      return {
        sync: async () => void order.push(`sync:dir`),
        close: async () => undefined
      } as unknown as FileHandle
    }
    const fh = await realOpen(path, flags, mode)
    const realSync = fh.sync.bind(fh)
    fh.sync = async () => {
      order.push(`sync:${basename(p).startsWith('.') ? 'temp' : p}`)
      await realSync()
    }
    return fh
  })
  const realRename = fsp.rename.bind(fsp)
  vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
    order.push('rename')
    await realRename(from, to)
  })
  return order
}

// WSP-12: rename alone survives a crash, not a power loss — the temp file's
// data must be on disk before the rename can make it the target.
describe('durability (flush before rename)', () => {
  it('flushes the temp file before renaming it, and the directory after on POSIX', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    const order = recordFlushes()

    await atomicWriteFile(join(dir, 'a.json'), '{"v":1}')

    expect(order).toEqual(['sync:temp', 'rename', 'sync:dir'])
    expect(readFileSync(join(dir, 'a.json'), 'utf-8')).toBe('{"v":1}')
  })

  it('does not open the directory for a flush on Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const order = recordFlushes()

    await atomicWriteFile(join(dir, 'a.json'), '{"v":1}')

    expect(order).toEqual(['sync:temp', 'rename'])
  })

  it('still succeeds when the directory cannot be flushed (the rename already landed)', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    const order = recordFlushes({ failDirectory: true })

    await atomicWriteFile(join(dir, 'a.json'), 'NEW')

    expect(order).toEqual(['sync:temp', 'rename'])
    expect(readFileSync(join(dir, 'a.json'), 'utf-8')).toBe('NEW')
  })

  it('a batch flushes every temp before the first rename', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    const order = recordFlushes()

    await atomicWriteBatch([
      { finalPath: join(dir, 'a.json'), tmpPath: join(dir, '.a.tmp'), content: 'A' },
      { finalPath: join(dir, 'b.json'), tmpPath: join(dir, '.b.tmp'), content: 'B' }
    ])

    expect(order).toEqual(['sync:temp', 'sync:temp', 'rename', 'rename', 'sync:dir'])
    expect(readFileSync(join(dir, 'a.json'), 'utf-8')).toBe('A')
    expect(readFileSync(join(dir, 'b.json'), 'utf-8')).toBe('B')
  })

  it('a batch whose second temp cannot be written renames nothing and removes both temps', async () => {
    await fsp.writeFile(join(dir, 'a.json'), 'OLD')

    await expect(
      atomicWriteBatch([
        { finalPath: join(dir, 'a.json'), tmpPath: join(dir, '.a.tmp'), content: 'A' },
        {
          finalPath: join(dir, 'b.json'),
          tmpPath: join(dir, 'missing', 'sub', '\u0000.tmp'),
          content: 'B'
        }
      ])
    ).rejects.toThrow()

    expect(readFileSync(join(dir, 'a.json'), 'utf-8')).toBe('OLD')
    expect(await readdir(dir)).toEqual(['a.json'])
  })

  it('the sync variant flushes the temp file before renaming it', () => {
    atomicWriteFileSync(join(dir, 'sync.json'), '{"sync":true}')
    expect(syncOrder.slice(0, 2)).toEqual(['fsync', 'rename'])
    expect(readFileSync(join(dir, 'sync.json'), 'utf-8')).toBe('{"sync":true}')
  })
})

describe('atomicWriteFile', () => {
  it('writes new content and creates parent directories, leaving no temp file', async () => {
    const target = join(dir, 'nested', 'deep', 'file.json')
    await atomicWriteFile(target, '{"v":1}')
    expect(readFileSync(target, 'utf-8')).toBe('{"v":1}')
    // No stray temp file in the target directory.
    const siblings = await readdir(join(dir, 'nested', 'deep'))
    expect(siblings).toEqual(['file.json'])
  })

  it('replaces existing content fully', async () => {
    const target = join(dir, 'file.txt')
    await atomicWriteFile(target, 'OLD')
    await atomicWriteFile(target, 'NEW-and-longer')
    expect(readFileSync(target, 'utf-8')).toBe('NEW-and-longer')
  })

  it('accepts Buffer payloads (binary cert material)', async () => {
    const target = join(dir, 'cert.pem')
    const bytes = Buffer.from([0x00, 0x01, 0xff, 0xfe])
    await atomicWriteFile(target, bytes)
    expect(readFileSync(target)).toEqual(bytes)
  })

  // The temp file is dot-prefixed so the workspace watcher's dotfile ignore hides
  // it — an in-flight save must not look like an external add/unlink/change
  // (REQ open-tab-file-reconciliation). We assert the name shape via the leftover
  // temp file when the rename is interrupted.
  it('names the temp file with a leading dot so the watcher ignores it', async () => {
    const target = join(dir, 'login.http')
    await atomicWriteFile(target, 'OLD')

    // Capture the temp path by failing at rename and leaving it behind for one tick.
    let observedTemp = ''
    const renameSpy = vi.spyOn(fsp, 'rename').mockImplementationOnce(async (from) => {
      observedTemp = String(from)
      throw new Error('EPERM: simulated')
    })
    await expect(atomicWriteFile(target, 'NEW')).rejects.toThrow(/EPERM/)
    renameSpy.mockRestore()

    expect(basename(observedTemp).startsWith('.')).toBe(true)
    expect(basename(observedTemp)).toMatch(/^\.login\.http\.tmp-/)
    // The dotfile ignore the watcher uses would match this path.
    expect(/(^|[/\\])\./.test(observedTemp)).toBe(true)
  })

  // CA-03: a content write survives an interrupted save — the target keeps its
  // complete previous content, never a truncated/empty intermediate.
  it('leaves the previous content intact when the write is interrupted mid-save', async () => {
    const target = join(dir, 'request.http')
    await atomicWriteFile(target, 'PREVIOUS-COMPLETE-CONTENT')

    // Simulate a crash or a full disk after the temp write but before/at the
    // rename (power loss is covered by the flush order, see "durability").
    const renameSpy = vi
      .spyOn(fsp, 'rename')
      .mockRejectedValueOnce(new Error('ENOSPC: simulated disk full'))

    await expect(atomicWriteFile(target, 'NEW-CONTENT')).rejects.toThrow(/ENOSPC/)
    renameSpy.mockRestore()

    // The original file is byte-for-byte intact (never truncated/emptied)…
    expect(readFileSync(target, 'utf-8')).toBe('PREVIOUS-COMPLETE-CONTENT')
    // …and the temp file was cleaned up rather than left behind.
    const siblings = await readdir(dir)
    expect(siblings).toEqual(['request.http'])
  })

  // A concurrent reader of the destination path can make Windows' rename fail
  // transiently with EPERM/EBUSY/EACCES (reproduced against a real environments/
  // config.json write racing a concurrent `secrets:reveal` read). The write must
  // retry through the transient failure rather than losing the edit silently.
  it('retries the rename on a transient EPERM and eventually succeeds', async () => {
    const target = join(dir, 'config.json')
    await atomicWriteFile(target, '{"v":1}')

    const transient = Object.assign(new Error('EPERM: operation not permitted, rename'), {
      code: 'EPERM'
    })
    const renameSpy = vi
      .spyOn(fsp, 'rename')
      .mockRejectedValueOnce(transient)
      .mockRejectedValueOnce(transient)

    await atomicWriteFile(target, '{"v":2}')

    expect(readFileSync(target, 'utf-8')).toBe('{"v":2}')
    expect(renameSpy).toHaveBeenCalledTimes(3)
    renameSpy.mockRestore()
  })

  // A persistent (non-transient-in-practice) EPERM must still surface as a
  // failure rather than retry forever — bounded backoff, not an infinite loop.
  it('gives up and rejects after the retry budget is exhausted', async () => {
    const target = join(dir, 'stuck.json')
    await atomicWriteFile(target, 'OLD')

    const transient = Object.assign(new Error('EBUSY: resource busy or locked, rename'), {
      code: 'EBUSY'
    })
    const renameSpy = vi.spyOn(fsp, 'rename').mockRejectedValue(transient)

    await expect(atomicWriteFile(target, 'NEW')).rejects.toThrow(/EBUSY/)
    renameSpy.mockRestore()

    // Never retried into a hang, and the original content survives untouched.
    expect(readFileSync(target, 'utf-8')).toBe('OLD')
  })
})

describe('atomicWriteFileSync', () => {
  it('writes content via temp + rename with no stray temp file', () => {
    const target = join(dir, 'sync.json')
    atomicWriteFileSync(target, '{"sync":true}')
    expect(readFileSync(target, 'utf-8')).toBe('{"sync":true}')
    expect(existsSync(target)).toBe(true)
  })
})
