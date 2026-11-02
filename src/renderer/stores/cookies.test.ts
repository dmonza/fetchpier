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
