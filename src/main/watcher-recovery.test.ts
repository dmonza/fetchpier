/**
 * REQ-0113 §6.1–§6.4 — the watcher contains its own failures and recovers.
 *
 * Unlike `watcher.test.ts`, which drives the real chokidar over tmpdirs to prove
 * lifecycle serialization, this suite mocks chokidar so the error signal, the
 * recovery ladder and its exhaustion are deterministic rather than timing-bound.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

/** Stand-in for chokidar's FSWatcher: a real emitter, so a missing 'error' listener throws. */
class FakeWatcher extends EventEmitter {
  close = vi.fn(async (): Promise<void> => {})
}

const h = vi.hoisted(() => ({
  created: [] as EventEmitter[],
  send: vi.fn(),
  mkdir: vi.fn(async (): Promise<void> => {}),
  treeRead: vi.fn(async (): Promise<unknown[]> => [])
}))

vi.mock('chokidar', () => ({
  watch: vi.fn(() => {
    const w = new FakeWatcher()
    h.created.push(w)
    return w
  })
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: h.send } }]
  }
}))

vi.mock('fs', () => ({
  promises: { mkdir: h.mkdir },
  realpathSync: Object.assign(() => '/ws/requests', { native: () => '/ws/requests' })
}))

vi.mock('@fetchpier/core', () => ({
  workspace: {
    openWorkspace: () => ({
      tree: { requestsRoot: () => '/ws/requests', read: h.treeRead }
    })
  }
}))

let mod: typeof import('./watcher')

/** The watcher instance chokidar handed out most recently. */
const live = (): EventEmitter => h.created[h.created.length - 1]

const channels = (): string[] => h.send.mock.calls.map(([channel]) => channel as string)
const countOf = (channel: string): number => channels().filter((c) => c === channel).length

beforeEach(async () => {
  vi.useFakeTimers()
  h.created.length = 0
  h.send.mockClear()
  h.mkdir.mockClear()
  h.mkdir.mockResolvedValue(undefined)
  h.treeRead.mockClear()
  h.treeRead.mockResolvedValue([])
  vi.resetModules()
  mod = await import('./watcher')
})

afterEach(async () => {
  await mod.stopWatcher()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('watcher error containment (REQ-0113 §6.1)', () => {
  it('CA-01: an error does not escape as an unhandled emitter event', async () => {
    await mod.startWatcher('/ws')
    // A real EventEmitter throws on `emit('error')` with no listener — which in
    // the main process is the runtime crash dialog. This assertion is the bug.
    expect(() => live().emit('error', new Error('EPERM: watch failed'))).not.toThrow()
  })

  it('CA-02: an error whose recovery succeeds never reaches the user', async () => {
    await mod.startWatcher('/ws')
    const before = h.created.length

    live().emit('error', new Error('EPERM'))
    await vi.advanceTimersByTimeAsync(50)

    // Watching was re-established on the first (immediate) attempt…
    expect(h.created.length).toBe(before + 1)
    // …so no advisory, and the tree was refreshed.
    expect(countOf('filesystem:watchDegraded')).toBe(0)
    expect(countOf('filesystem:changed')).toBe(1)
  })
})

describe('watcher recovery ladder (REQ-0113 §6.3/§6.4)', () => {
  it('CA-06: the advisory is sent only after all three attempts fail', async () => {
    await mod.startWatcher('/ws')
    // Every re-establishment fails from here on: the request root cannot be ensured.
    h.mkdir.mockRejectedValue(new Error('ENOENT: drive gone'))

    live().emit('error', new Error('EPERM'))

    // Attempt 1 is immediate; nothing is surfaced yet.
    await vi.advanceTimersByTimeAsync(50)
    expect(countOf('filesystem:watchDegraded')).toBe(0)

    // Attempt 2 at ~1 s — still silent while a retry is pending.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(countOf('filesystem:watchDegraded')).toBe(0)

    // Attempt 3 at ~5 s exhausts the budget.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(countOf('filesystem:watchDegraded')).toBe(1)
  })

  it('does not repeat the advisory once degraded', async () => {
    await mod.startWatcher('/ws')
    h.mkdir.mockRejectedValue(new Error('ENOENT'))

    live().emit('error', new Error('EPERM'))
    await vi.advanceTimersByTimeAsync(7_000)
    expect(countOf('filesystem:watchDegraded')).toBe(1)

    // A flapping watcher must not turn the advisory into a notification storm.
    live().emit('error', new Error('EPERM again'))
    await vi.advanceTimersByTimeAsync(7_000)
    expect(countOf('filesystem:watchDegraded')).toBe(1)
  })

  it('opening a workspace refills the recovery budget', async () => {
    await mod.startWatcher('/ws')
    h.mkdir.mockRejectedValue(new Error('ENOENT'))
    live().emit('error', new Error('EPERM'))
    await vi.advanceTimersByTimeAsync(7_000)
    expect(countOf('filesystem:watchDegraded')).toBe(1)

    // The user reopens the workspace and the drive is back.
    h.mkdir.mockResolvedValue(undefined)
    await mod.startWatcher('/ws')
    h.send.mockClear()
    h.mkdir.mockRejectedValue(new Error('ENOENT'))

    live().emit('error', new Error('EPERM'))
    await vi.advanceTimersByTimeAsync(7_000)
    // Budget refilled, so the ladder ran again and reached the advisory again.
    expect(countOf('filesystem:watchDegraded')).toBe(1)
  })
})

describe('focus re-scan (REQ-0113 §6.2)', () => {
  it('CA-04: a burst of focus events collapses into one tree read', async () => {
    await mod.startWatcher('/ws')
    h.treeRead.mockClear()

    mod.requestRescan()
    mod.requestRescan()
    mod.requestRescan()
    await vi.advanceTimersByTimeAsync(500)

    expect(h.treeRead).toHaveBeenCalledTimes(1)
    expect(countOf('filesystem:changed')).toBe(1)
  })

  it('is a no-op when no workspace is open', async () => {
    mod.requestRescan()
    await vi.advanceTimersByTimeAsync(500)
    expect(h.treeRead).not.toHaveBeenCalled()
  })

  it('re-scans even while watching is healthy — the lever is detection-free', async () => {
    await mod.startWatcher('/ws')
    h.treeRead.mockClear()
    mod.requestRescan()
    await vi.advanceTimersByTimeAsync(500)
    expect(h.treeRead).toHaveBeenCalledTimes(1)
  })
})

describe('system resume (REQ-0113 §6.3)', () => {
  it('CA-05: resume re-establishes watching and re-scans', async () => {
    await mod.startWatcher('/ws')
    const before = h.created.length
    h.send.mockClear()

    await mod.handleSystemResume()

    expect(h.created.length).toBe(before + 1)
    expect(countOf('filesystem:changed')).toBe(1)
  })

  it('is a no-op when no workspace is open', async () => {
    await mod.handleSystemResume()
    expect(h.created).toHaveLength(0)
  })
})
