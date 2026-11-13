import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Cookie } from '../../shared/types'

// The cookies store registers a `cookies:changed` listener at module-load
// time, so window.api must already exist BEFORE importing the module.
// vi.resetModules() inside beforeEach ensures a fresh module evaluation per
// test, with the current mock attached to window.

let store: typeof import('./cookies').useCookieStore
let onChangedCb: ((envId: string | null) => void) | null = null

function makeCookie(overrides: Partial<Cookie> = {}): Cookie {
  return {
    id: 'c1',
    name: 'sid',
    value: 'abc',
    domain: 'example.com',
    path: '/',
    expires: null,
    maxAge: null,
    secure: false,
    httpOnly: false,
    sameSite: null,
    hostOnly: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    source: 'manual',
    ...overrides
  }
}

function makeApi() {
  onChangedCb = null
  return {
    cookies: {
      setActiveEnvironment: vi.fn(),
      list: vi.fn().mockResolvedValue([] as Cookie[]),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      clear: vi.fn(),
      onChanged: vi.fn((cb: (envId: string | null) => void) => {
        onChangedCb = cb
      })
    }
  }
}

let api: ReturnType<typeof makeApi>

beforeEach(async () => {
  vi.resetModules()
  api = makeApi()
  vi.stubGlobal('window', { api })
  const mod = await import('./cookies')
  store = mod.useCookieStore
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('cookies store — module-load subscription', () => {
  it('registers a cookies:changed listener at module load', () => {
    expect(api.cookies.onChanged).toHaveBeenCalledTimes(1)
  })
})

describe('loadForEnvironment', () => {
  it('forwards the env id to the IPC and resets cookies to []', async () => {
    api.cookies.list.mockResolvedValueOnce([makeCookie()])
    await store.getState().loadForEnvironment('dev')
    expect(api.cookies.setActiveEnvironment).toHaveBeenCalledWith('dev')
    expect(api.cookies.list).toHaveBeenCalledWith('dev')
    expect(store.getState().cookies).toHaveLength(1)
    expect(store.getState().environmentId).toBe('dev')
    expect(store.getState().isLoading).toBe(false)
  })

  it('clears cookies when envId is null without calling list', async () => {
    await store.getState().loadForEnvironment(null)
    expect(api.cookies.setActiveEnvironment).toHaveBeenCalledWith(null)
    expect(api.cookies.list).not.toHaveBeenCalled()
    expect(store.getState().cookies).toEqual([])
    expect(store.getState().environmentId).toBeNull()
    expect(store.getState().isLoading).toBe(false)
  })

  it('falls back to empty array when list throws and still clears isLoading', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    api.cookies.list.mockRejectedValueOnce(new Error('disk full'))
    await store.getState().loadForEnvironment('dev')
    expect(store.getState().cookies).toEqual([])
    expect(store.getState().isLoading).toBe(false)
    errSpy.mockRestore()
  })

  it('keeps the load failure so the panel can explain it, and clears it on success (ENG-37)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    api.cookies.list.mockRejectedValueOnce(new Error('COOKIE_JAR_UNREADABLE: bad json'))
    await store.getState().loadForEnvironment('dev')
    expect(store.getState().loadError).toBe('COOKIE_JAR_UNREADABLE: bad json')
    await store.getState().loadForEnvironment('dev')
    expect(store.getState().loadError).toBeNull()
    errSpy.mockRestore()
  })

  // The banner recommends Clear all, or fixing the file: either way out must
  // take the banner down, without reopening the panel (ENG-37 review).
  it('clears the load failure once Clear all succeeds', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    api.cookies.list.mockRejectedValueOnce(new Error('COOKIE_JAR_UNREADABLE: bad json'))
    await store.getState().loadForEnvironment('dev')
    await store.getState().clearAll()
    expect(store.getState().loadError).toBeNull()
    errSpy.mockRestore()
  })

  it('clears the load failure when a cookies:changed refresh reads the jar', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    api.cookies.list.mockRejectedValueOnce(new Error('COOKIE_JAR_UNREADABLE: bad json'))
    await store.getState().loadForEnvironment('dev')
    api.cookies.list.mockResolvedValueOnce([makeCookie()])
    onChangedCb!('dev')
    await Promise.resolve()
    await Promise.resolve()
    expect(store.getState().loadError).toBeNull()
    expect(store.getState().cookies).toHaveLength(1)
    errSpy.mockRestore()
  })
})

describe('create / update / remove are guarded by environmentId', () => {
  const sample = {
    name: 'sid',
    value: '1',
    domain: 'example.com',
    path: '/',
    expires: null,
    maxAge: null,
    secure: false,
    httpOnly: false,
    sameSite: null,
    hostOnly: true
  } as const

  it('create() is a no-op when no environment is active', async () => {
    await store.getState().create(sample)
    expect(api.cookies.create).not.toHaveBeenCalled()
  })

  it('create() forwards to IPC and refreshes the list', async () => {
    await store.getState().loadForEnvironment('dev')
    api.cookies.list.mockResolvedValueOnce([makeCookie({ name: 'sid' })])
    await store.getState().create(sample)
    expect(api.cookies.create).toHaveBeenCalledWith('dev', { ...sample, source: 'manual' })
    expect(store.getState().cookies).toHaveLength(1)
  })

  it('update() forwards id + changes and refreshes', async () => {
    await store.getState().loadForEnvironment('dev')
    api.cookies.list.mockResolvedValueOnce([makeCookie({ value: 'new' })])
    await store.getState().update('c1', { value: 'new' })
    expect(api.cookies.update).toHaveBeenCalledWith('dev', 'c1', { value: 'new' })
    expect(store.getState().cookies[0].value).toBe('new')
  })

  it('update() is a no-op without env', async () => {
    await store.getState().update('c1', { value: 'x' })
    expect(api.cookies.update).not.toHaveBeenCalled()
  })

  it('remove() forwards id and refreshes', async () => {
    await store.getState().loadForEnvironment('dev')
    api.cookies.list.mockResolvedValueOnce([])
    await store.getState().remove('c1')
    expect(api.cookies.delete).toHaveBeenCalledWith('dev', 'c1')
    expect(store.getState().cookies).toEqual([])
  })

  it('clearAll() drops in-memory cookies without re-listing', async () => {
    await store.getState().loadForEnvironment('dev')
    store.setState({ cookies: [makeCookie()] })
    await store.getState().clearAll()
    expect(api.cookies.clear).toHaveBeenCalledWith('dev')
    expect(store.getState().cookies).toEqual([])
    // clearAll should NOT call list — the store mirrors the optimistic empty state.
    expect(api.cookies.list).toHaveBeenCalledTimes(1) // only the load earlier
  })
})

describe('cookies:changed subscription behaviour', () => {
  it('refreshes when the broadcast envId matches the active environment', async () => {
    await store.getState().loadForEnvironment('dev')
    api.cookies.list.mockClear()
    api.cookies.list.mockResolvedValueOnce([makeCookie({ name: 'fresh' })])

    expect(onChangedCb).not.toBeNull()
    onChangedCb!('dev')
    // The handler returns a Promise — wait one microtask tick.
    await Promise.resolve()
    await Promise.resolve()

    expect(api.cookies.list).toHaveBeenCalledWith('dev')
    expect(store.getState().cookies[0]?.name).toBe('fresh')
  })

  it('ignores broadcasts for a different environment', async () => {
    await store.getState().loadForEnvironment('dev')
    api.cookies.list.mockClear()

    onChangedCb!('other-env')
    await Promise.resolve()

    expect(api.cookies.list).not.toHaveBeenCalled()
  })

  it('ignores broadcasts when no environment is active', async () => {
    expect(store.getState().environmentId).toBeNull()
    api.cookies.list.mockClear()
    onChangedCb!('dev')
    await Promise.resolve()
    expect(api.cookies.list).not.toHaveBeenCalled()
  })

  it('logs but does not crash when the refresh list call rejects', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await store.getState().loadForEnvironment('dev')
    api.cookies.list.mockClear()
    api.cookies.list.mockRejectedValueOnce(new Error('boom'))

    onChangedCb!('dev')
    // Two ticks: one for the promise chain, one for the catch.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })
})

// UI-05: replies can come back out of order. A late reply for an environment
// that is no longer the active one is dropped, whichever call made it.
describe('a late reply for an environment that is no longer active is dropped (UI-05)', () => {
  function deferred<T>(): {
    promise: Promise<T>
    resolve: (v: T) => void
    reject: (e: unknown) => void
  } {
    let resolve!: (v: T) => void
    let reject!: (e: unknown) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }

  const A = [makeCookie({ id: 'a1', name: 'fromA' })]
  const B = [makeCookie({ id: 'b1', name: 'fromB' })]

  // The load of A must already be waiting on list('A') when the switch lands,
  // so these exercise the checks after the list reply (not the earlier one).
  const listStarted = (env: string): Promise<void> =>
    vi.waitFor(() => expect(api.cookies.list).toHaveBeenCalledWith(env))

  it('keeps B when list(A) resolves after list(B)', async () => {
    const listA = deferred<Cookie[]>()
    api.cookies.list.mockImplementation((env: string) =>
      env === 'A' ? listA.promise : Promise.resolve(B)
    )
    const loadA = store.getState().loadForEnvironment('A')
    await listStarted('A')
    await store.getState().loadForEnvironment('B')
    listA.resolve(A)
    await loadA
    expect(store.getState()).toMatchObject({ environmentId: 'B', cookies: B, isLoading: false })
  })

  it('keeps the empty list when list(A) resolves after a switch to no environment', async () => {
    const listA = deferred<Cookie[]>()
    api.cookies.list.mockImplementation(() => listA.promise)
    const loadA = store.getState().loadForEnvironment('A')
    await listStarted('A')
    await store.getState().loadForEnvironment(null)
    listA.resolve(A)
    await loadA
    expect(store.getState()).toMatchObject({ environmentId: null, cookies: [], isLoading: false })
  })

  it('does not report a late failure of A over the loaded B', async () => {
    const listA = deferred<Cookie[]>()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    api.cookies.list.mockImplementation((env: string) =>
      env === 'A' ? listA.promise : Promise.resolve(B)
    )
    const loadA = store.getState().loadForEnvironment('A')
    await listStarted('A')
    await store.getState().loadForEnvironment('B')
    listA.reject(new Error('jar unreadable'))
    await loadA
    expect(store.getState()).toMatchObject({ environmentId: 'B', cookies: B, loadError: null })
    errSpy.mockRestore()
  })

  it('does not list A when its setActiveEnvironment resolves after the switch to B', async () => {
    const activateA = deferred<void>()
    api.cookies.setActiveEnvironment.mockImplementation((env: string | null) =>
      env === 'A' ? activateA.promise : Promise.resolve()
    )
    api.cookies.list.mockImplementation((env: string) => Promise.resolve(env === 'A' ? A : B))
    const loadA = store.getState().loadForEnvironment('A')
    await store.getState().loadForEnvironment('B')
    activateA.resolve()
    await loadA
    expect(api.cookies.list).not.toHaveBeenCalledWith('A')
    expect(store.getState()).toMatchObject({ environmentId: 'B', cookies: B })
  })

  it('drops a cookies:changed refresh of A that resolves after the switch to B', async () => {
    api.cookies.list.mockResolvedValueOnce(A)
    await store.getState().loadForEnvironment('A')
    const refreshA = deferred<Cookie[]>()
    api.cookies.list.mockImplementation((env: string) =>
      env === 'A' ? refreshA.promise : Promise.resolve(B)
    )
    onChangedCb!('A')
    await store.getState().loadForEnvironment('B')
    refreshA.resolve(A)
    await Promise.resolve()
    await Promise.resolve()
    expect(store.getState()).toMatchObject({ environmentId: 'B', cookies: B })
  })

  it('drops the reload after a mutation of A once B is active', async () => {
    api.cookies.list.mockResolvedValueOnce(A)
    await store.getState().loadForEnvironment('A')
    const deleteA = deferred<void>()
    api.cookies.delete.mockImplementation(() => deleteA.promise)
    api.cookies.list.mockImplementation((env: string) => Promise.resolve(env === 'A' ? [] : B))
    const removal = store.getState().remove('a1')
    await store.getState().loadForEnvironment('B')
    deleteA.resolve()
    await removal
    expect(api.cookies.delete).toHaveBeenCalledWith('A', 'a1')
    expect(store.getState()).toMatchObject({ environmentId: 'B', cookies: B })
  })
})
