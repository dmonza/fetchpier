import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RequestUiState, RequestUiStateMap } from '../../shared/types'

// The uiState store registers a `ui-state:changed` listener at module-load
// time, so window.api must already exist BEFORE importing the module.
let store: typeof import('./uiState').useUiStateStore
let onChangedCb: ((payload: { requestId: string; state: RequestUiState | null }) => void) | null =
  null

function makeApi() {
  onChangedCb = null
  return {
    uiState: {
      read: vi.fn().mockResolvedValue(null as RequestUiState | null),
      readAll: vi.fn().mockResolvedValue({} as RequestUiStateMap),
      write: vi.fn().mockResolvedValue(null as RequestUiState | null),
      delete: vi.fn().mockResolvedValue(undefined),
      onChanged: vi.fn(
        (cb: (payload: { requestId: string; state: RequestUiState | null }) => void) => {
          onChangedCb = cb
          return (): void => {
            // unsubscribe no-op for the test
          }
        }
      )
    }
  }
}

let api: ReturnType<typeof makeApi>

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  api = makeApi()
  vi.stubGlobal('window', { api })
  const mod = await import('./uiState')
  store = mod.useUiStateStore
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('uiState store — module-load subscription', () => {
  it('registers a ui-state:changed listener at module load', () => {
    expect(api.uiState.onChanged).toHaveBeenCalledTimes(1)
  })
})

describe('get / setForRequest', () => {
  it('returns null for unknown ids', () => {
    expect(store.getState().get('unknown')).toBeNull()
  })

  it('falls back to {} default state', () => {
    expect(store.getState().map).toEqual({})
  })

  it('setForRequest merges into the cache immediately (sync)', () => {
    store.getState().setForRequest('id-a', { activeReqTab: 'body' })
    expect(store.getState().get('id-a')).toEqual({ activeReqTab: 'body' })

    store.getState().setForRequest('id-a', { activeResponseTab: 'tests' })
    expect(store.getState().get('id-a')).toEqual({
      activeReqTab: 'body',
      activeResponseTab: 'tests'
    })
  })

  it('setForRequest is a no-op without a request id', () => {
    store.getState().setForRequest('', { activeReqTab: 'body' })
    expect(store.getState().map).toEqual({})
  })
})

describe('debounced IPC write', () => {
  it('coalesces multiple setForRequest calls into a single IPC write per request id', () => {
    store.getState().setForRequest('id-a', { activeReqTab: 'body' })
    store.getState().setForRequest('id-a', { activeResponseTab: 'tests' })
    store.getState().setForRequest('id-a', { activeScriptPhase: 'post' })
    expect(api.uiState.write).not.toHaveBeenCalled()
    vi.advanceTimersByTime(500)
    expect(api.uiState.write).toHaveBeenCalledTimes(1)
    expect(api.uiState.write).toHaveBeenCalledWith('id-a', {
      activeReqTab: 'body',
      activeResponseTab: 'tests',
      activeScriptPhase: 'post'
    })
  })

  it('debounces independently per request id', () => {
    store.getState().setForRequest('id-a', { activeReqTab: 'body' })
    store.getState().setForRequest('id-b', { activeReqTab: 'headers' })
    vi.advanceTimersByTime(500)
    expect(api.uiState.write).toHaveBeenCalledTimes(2)
    expect(api.uiState.write).toHaveBeenCalledWith('id-a', { activeReqTab: 'body' })
    expect(api.uiState.write).toHaveBeenCalledWith('id-b', { activeReqTab: 'headers' })
  })

  it('does not fire IPC before the debounce window elapses', () => {
    store.getState().setForRequest('id-a', { activeReqTab: 'body' })
    vi.advanceTimersByTime(499)
    expect(api.uiState.write).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(api.uiState.write).toHaveBeenCalledTimes(1)
  })
})

describe('loadAll', () => {
  it('pulls the full map from main and replaces the cache', async () => {
    api.uiState.readAll.mockResolvedValueOnce({
      'id-a': { activeReqTab: 'body' },
      'id-b': { activeResponseTab: 'tests' }
    })
    vi.useRealTimers()
    await store.getState().loadAll('/tmp/ws')
    expect(store.getState().get('id-a')).toEqual({ activeReqTab: 'body' })
    expect(store.getState().get('id-b')).toEqual({ activeResponseTab: 'tests' })
    expect(store.getState().loadedFor).toBe('/tmp/ws')
  })

  it('preserves optimistic local writes that happened during the load', async () => {
    // Stage 1: optimistic local write
    store.getState().setForRequest('id-a', { activeReqTab: 'body' })

    // Stage 2: load resolves with a stale snapshot
    api.uiState.readAll.mockResolvedValueOnce({
      'id-a': { activeReqTab: 'headers' },
      'id-b': { activeReqTab: 'auth' }
    })
    vi.useRealTimers()
    await store.getState().loadAll('/tmp/ws')

    // Local write wins for 'id-a' (it's newer); 'id-b' is added from snapshot.
    expect(store.getState().get('id-a')).toEqual({ activeReqTab: 'body' })
    expect(store.getState().get('id-b')).toEqual({ activeReqTab: 'auth' })
  })
})

describe('clear', () => {
  it('drops all in-memory state', async () => {
    store.getState().setForRequest('id-a', { activeReqTab: 'body' })
    expect(store.getState().get('id-a')).not.toBeNull()
    store.getState().clear()
    expect(store.getState().map).toEqual({})
    expect(store.getState().loadedFor).toBeNull()
  })

  it('cancels pending debounced writes so they do not fire post-clear', () => {
    store.getState().setForRequest('id-a', { activeReqTab: 'body' })
    store.getState().clear()
    vi.advanceTimersByTime(1000)
    expect(api.uiState.write).not.toHaveBeenCalled()
  })
})

describe('applyExternal (broadcast)', () => {
  it('updates the cache without re-triggering an IPC write', () => {
    store.getState().applyExternal('id-a', { activeReqTab: 'body' })
    expect(store.getState().get('id-a')).toEqual({ activeReqTab: 'body' })
    vi.advanceTimersByTime(1000)
    expect(api.uiState.write).not.toHaveBeenCalled()
  })

  it('removes the entry when state is null', () => {
    store.getState().setForRequest('id-a', { activeReqTab: 'body' })
    vi.advanceTimersByTime(500) // flush so map still has the entry
    store.getState().applyExternal('id-a', null)
    expect(store.getState().get('id-a')).toBeNull()
  })

  it('is a no-op without a request id', () => {
    store.getState().applyExternal('', { activeReqTab: 'body' })
    expect(store.getState().map).toEqual({})
  })

  it('removes the entry when state has no fields', () => {
    store.getState().setForRequest('id-a', { activeReqTab: 'body' })
    vi.advanceTimersByTime(500)
    store.getState().applyExternal('id-a', {})
    expect(store.getState().get('id-a')).toBeNull()
  })

  it('responds to broadcasts via the registered onChanged handler', () => {
    expect(onChangedCb).not.toBeNull()
    onChangedCb!({ requestId: 'id-x', state: { activeReqTab: 'auth' } })
    expect(store.getState().get('id-x')).toEqual({ activeReqTab: 'auth' })
  })
})
