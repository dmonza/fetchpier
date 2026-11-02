/**
 * Canonical-path resolution for the filesystem watcher.
 *
 * Cases WATCH-001 / WATCH-002.
 *
 * `chokidar` is substituted here so the exact path handed to it is observable, and so an
 * event can be driven synchronously. That is incompatible with `watcher.test.ts`, which
 * deliberately drives the real chokidar over real directories, hence the separate file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, symlink } from 'fs/promises'
import { realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const send = vi.fn()

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send } }]
  }
}))

/** Records the path chokidar was asked to watch and exposes its event handlers. */
const handlers = new Map<string, (path: string) => void>()
let watchedPath: string | null = null

vi.mock('chokidar', () => ({
  watch: (path: string) => {
    watchedPath = path
    const instance = {
      on: (event: string, handler: (path: string) => void) => {
        handlers.set(event, handler)
        return instance
      },
      close: async (): Promise<void> => undefined
    }
    return instance
  }
}))

let mod: typeof import('./watcher')
let realRoot: string
/** A second path to the SAME directory, whose realpath differs from itself. */
let linkedRoot: string

beforeEach(async () => {
  send.mockClear()
  handlers.clear()
  watchedPath = null
  vi.resetModules()
  mod = await import('./watcher')

  const base = realpathSync.native(await mkdtemp(join(tmpdir(), 'fp-watch-resolve-')))
  realRoot = join(base, 'real-workspace')
  await mkdir(join(realRoot, 'requests'), { recursive: true })

  linkedRoot = join(base, 'linked-workspace')
  // `junction` is the one directory-link type Windows grants without elevation; on POSIX
  // Node treats it as a plain directory symlink.
  await symlink(realRoot, linkedRoot, 'junction')
})

afterEach(async () => {
  await mod.stopWatcher()
  await rm(realRoot, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('watcher canonical-path resolution', () => {
  it('WATCH-001: watches the resolved path when handed a non-canonical one', async () => {
    await mod.startWatcher(linkedRoot)

    expect(watchedPath).not.toBeNull()
    // The whole point: what libuv receives must be what the OS will report events with.
    expect(watchedPath).toBe(realpathSync.native(join(linkedRoot, 'requests')))
    expect(watchedPath).not.toBe(join(linkedRoot, 'requests'))
  })

  it('WATCH-002: emits file-change paths in the caller namespace, not the resolved one', async () => {
    await mod.startWatcher(linkedRoot)

    const changed = handlers.get('change')
    expect(changed).toBeDefined()
    // chokidar reports from the namespace it was given — the resolved one.
    changed?.(join(realpathSync.native(join(linkedRoot, 'requests')), 'login.http'))

    expect(send).toHaveBeenCalledWith(
      'filesystem:fileChanged',
      join(linkedRoot, 'requests', 'login.http')
    )
  })

  it('WATCH-003: leaves an already-canonical path untouched', async () => {
    await mod.startWatcher(realRoot)

    const requests = join(realRoot, 'requests')
    expect(watchedPath).toBe(requests)

    handlers.get('change')?.(join(requests, 'login.http'))
    expect(send).toHaveBeenCalledWith('filesystem:fileChanged', join(requests, 'login.http'))
  })
})
