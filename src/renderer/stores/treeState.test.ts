import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let mod: typeof import('./treeState')
let store: typeof import('./treeState').useTreeStateStore

function makeApi() {
  return {
    treeState: {
      read: vi.fn().mockResolvedValue(null as string[] | null),
      write: vi.fn().mockResolvedValue(undefined)
    }
  }
}

let api: ReturnType<typeof makeApi>

const WS = '/ws'
const abs = (rel: string): string => `${WS}/requests/${rel}`

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  api = makeApi()
  vi.stubGlobal('window', { api })
  mod = await import('./treeState')
  store = mod.useTreeStateStore
})

afterEach(() => {
  // Several tests below drive `load()` under REAL timers, so the debounced
  // write they schedule is a real 400 ms timer that outlives the test. It then
  // fires after `unstubAllGlobals()` has removed `window.api` and aborts the
  // whole run with an uncaught `TypeError: Cannot read properties of undefined
  // (reading 'treeState')` — while every test still reports green, which makes
  // it read as an unexplained red. `clear()` is the store's own cancel path for
  // a pending write (it `clearTimeout`s the module-level handle), so this needs
  // no null-guard in the product code. It must run BEFORE the globals go.
  store.getState().clear()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('toRel', () => {
  it('strips the workspace prefix and normalizes backslashes', () => {
    expect(mod.toRel('/ws/requests/a/b', '/ws')).toBe('requests/a/b')
    expect(mod.toRel('C:\\ws\\requests\\a', 'C:\\ws')).toBe('requests/a')
  })

  it('falls back to a normalized absolute path when no workspace', () => {
    expect(mod.toRel('C:\\x\\y', null)).toBe('C:/x/y')
  })
})

describe('isExpanded before ready', () => {
  it('returns true for every folder while not ready (no flash collapse)', () => {
    expect(store.getState().ready).toBe(false)
    expect(store.getState().isExpanded(abs('anything'))).toBe(true)
  })
})

describe('load', () => {
  it('marks seedPending when read returns null (first run)', async () => {
    vi.useRealTimers()
    api.treeState.read.mockResolvedValueOnce(null)
    await store.getState().load(WS)
    expect(store.getState().ready).toBe(true)
    expect(store.getState().seedPending).toBe(true)
  })

  it('populates the expanded set when read returns an array', async () => {
    vi.useRealTimers()
    api.treeState.read.mockResolvedValueOnce(['requests/a', 'requests/a/b'])
    await store.getState().load(WS)
    expect(store.getState().seedPending).toBe(false)
    expect(store.getState().isExpanded(abs('a'))).toBe(true)
    expect(store.getState().isExpanded(abs('a/b'))).toBe(true)
    expect(store.getState().isExpanded(abs('c'))).toBe(false)
  })

  it('respects an explicit empty array (user collapsed everything)', async () => {
    vi.useRealTimers()
    api.treeState.read.mockResolvedValueOnce([])
    await store.getState().load(WS)
    expect(store.getState().seedPending).toBe(false)
    expect(store.getState().isExpanded(abs('a'))).toBe(false)
  })
})

describe('reconcile — seeding', () => {
  it('seeds all existing folders as expanded on first run and persists', async () => {
    vi.useRealTimers()
    api.treeState.read.mockResolvedValueOnce(null)
    await store.getState().load(WS)

    // Switch to fake timers BEFORE the write is scheduled so we can flush it.
    vi.useFakeTimers()
    store.getState().reconcile([abs('a'), abs('a/b')])
    expect(store.getState().seedPending).toBe(false)
    expect(store.getState().isExpanded(abs('a'))).toBe(true)
    expect(store.getState().isExpanded(abs('a/b'))).toBe(true)

    vi.advanceTimersByTime(400)
    expect(api.treeState.write).toHaveBeenCalledWith(['requests/a', 'requests/a/b'])
  })

  it('defers reconcile that arrives before load resolves, then applies it', async () => {
    let resolveRead: (v: string[] | null) => void = () => {}
    api.treeState.read.mockReturnValueOnce(
      new Promise<string[] | null>((r) => {
        resolveRead = r
      })
    )
    const loadPromise = store.getState().load(WS)
    // Reconcile arrives while load is still pending.
    store.getState().reconcile([abs('a')])
    expect(store.getState().pendingFolderPaths).toEqual([abs('a')])

    vi.useRealTimers()
    resolveRead(null) // first run → seed
    await loadPromise
    expect(store.getState().pendingFolderPaths).toBeNull()
    expect(store.getState().isExpanded(abs('a'))).toBe(true)
  })
})

describe('reconcile — pruning', () => {
  it('drops expanded entries whose folder no longer exists and persists', async () => {
    vi.useRealTimers()
    api.treeState.read.mockResolvedValueOnce(['requests/a', 'requests/gone'])
    await store.getState().load(WS)

    vi.useFakeTimers()
    store.getState().reconcile([abs('a')]) // 'gone' is no longer a folder
    expect(store.getState().isExpanded(abs('a'))).toBe(true)
    expect(store.getState().isExpanded(abs('gone'))).toBe(false)

    vi.advanceTimersByTime(400)
    expect(api.treeState.write).toHaveBeenCalledWith(['requests/a'])
  })

  it('does not write when nothing changed', async () => {
    vi.useRealTimers()
    api.treeState.read.mockResolvedValueOnce(['requests/a'])
    await store.getState().load(WS)
    api.treeState.write.mockClear()

    store.getState().reconcile([abs('a'), abs('b')]) // 'b' just isn't expanded
    vi.useFakeTimers()
    vi.advanceTimersByTime(400)
    expect(api.treeState.write).not.toHaveBeenCalled()
  })
})

describe('reconcile — expandable requests (instance parents)', () => {
  it('does not prune an expanded instance-parent that is still expandable', async () => {
    vi.useRealTimers()
    api.treeState.read.mockResolvedValueOnce(['requests/login.http'])
    await store.getState().load(WS)

    vi.useFakeTimers()
    // folders = [], but login.http is still an expandable request.
    store.getState().reconcile([], [abs('login.http')])
    expect(store.getState().isExpanded(abs('login.http'))).toBe(true)
    vi.advanceTimersByTime(400)
    expect(api.treeState.write).not.toHaveBeenCalled()
  })

  it('prunes an instance-parent that is no longer expandable', async () => {
    vi.useRealTimers()
    api.treeState.read.mockResolvedValueOnce(['requests/login.http'])
    await store.getState().load(WS)

    vi.useFakeTimers()
    // No folders, no expandable requests → the stale entry is pruned.
    store.getState().reconcile([], [])
    expect(store.getState().isExpanded(abs('login.http'))).toBe(false)
    vi.advanceTimersByTime(400)
    expect(api.treeState.write).toHaveBeenCalledWith([])
  })

  it('seeds folders open by default but leaves instance-parents collapsed on first run', async () => {
    vi.useRealTimers()
    api.treeState.read.mockResolvedValueOnce(null)
    await store.getState().load(WS)

    vi.useFakeTimers()
    store.getState().reconcile([abs('a')], [abs('login.http')])
    expect(store.getState().isExpanded(abs('a'))).toBe(true)
    expect(store.getState().isExpanded(abs('login.http'))).toBe(false)
  })
})

describe('setExpanded', () => {
  beforeEach(async () => {
    vi.useRealTimers()
    api.treeState.read.mockResolvedValueOnce([])
    await store.getState().load(WS)
    vi.useFakeTimers()
  })

  it('expands a folder and writes (debounced)', () => {
    store.getState().setExpanded(abs('a'), true)
    expect(store.getState().isExpanded(abs('a'))).toBe(true)
    expect(api.treeState.write).not.toHaveBeenCalled()
    vi.advanceTimersByTime(400)
    expect(api.treeState.write).toHaveBeenCalledWith(['requests/a'])
  })

  it('collapses a folder', () => {
    store.getState().setExpanded(abs('a'), true)
    store.getState().setExpanded(abs('a'), false)
    expect(store.getState().isExpanded(abs('a'))).toBe(false)
    vi.advanceTimersByTime(400)
    expect(api.treeState.write).toHaveBeenLastCalledWith([])
  })

  it('coalesces rapid toggles into a single debounced write', () => {
    store.getState().setExpanded(abs('a'), true)
    store.getState().setExpanded(abs('b'), true)
    store.getState().setExpanded(abs('c'), true)
    expect(api.treeState.write).not.toHaveBeenCalled()
    vi.advanceTimersByTime(400)
    expect(api.treeState.write).toHaveBeenCalledTimes(1)
    expect(api.treeState.write).toHaveBeenCalledWith(['requests/a', 'requests/b', 'requests/c'])
  })

  it('is a no-op when the state is unchanged', () => {
    store.getState().setExpanded(abs('a'), false) // already collapsed
    vi.advanceTimersByTime(400)
    expect(api.treeState.write).not.toHaveBeenCalled()
  })
})

describe('collapseAll / expandAll', () => {
  beforeEach(async () => {
    vi.useRealTimers()
    api.treeState.read.mockResolvedValueOnce([]) // not first run; nothing expanded
    await store.getState().load(WS)
    vi.useFakeTimers()
    // Register the live folders so expandAll knows what to open.
    store.getState().reconcile([abs('a'), abs('a/b')])
  })

  it('expandAll opens every known folder and persists (CA-16)', () => {
    store.getState().expandAll()
    expect(store.getState().isExpanded(abs('a'))).toBe(true)
    expect(store.getState().isExpanded(abs('a/b'))).toBe(true)
    vi.advanceTimersByTime(400)
    expect(api.treeState.write).toHaveBeenLastCalledWith(['requests/a', 'requests/a/b'])
  })

  it('collapseAll clears the expanded set and persists (CA-16)', () => {
    store.getState().expandAll()
    store.getState().collapseAll()
    expect(store.getState().isExpanded(abs('a'))).toBe(false)
    vi.advanceTimersByTime(400)
    expect(api.treeState.write).toHaveBeenLastCalledWith([])
  })

  it('collapseAll is a no-op when nothing is expanded', () => {
    store.getState().collapseAll() // already empty
    vi.advanceTimersByTime(400)
    expect(api.treeState.write).not.toHaveBeenCalled()
  })
})

describe('clear', () => {
  it('resets state and cancels pending writes', async () => {
    vi.useRealTimers()
    api.treeState.read.mockResolvedValueOnce([])
    await store.getState().load(WS)
    vi.useFakeTimers()

    store.getState().setExpanded(abs('a'), true)
    store.getState().clear()
    expect(store.getState().ready).toBe(false)
    expect(store.getState().workspacePath).toBeNull()
    vi.advanceTimersByTime(1000)
    expect(api.treeState.write).not.toHaveBeenCalled()
  })
})
