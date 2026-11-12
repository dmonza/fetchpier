import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The workspace store's collaborators are out of scope here: only how the
// detached Activity window learns (and follows) the active workspace is tested.
const h = vi.hoisted(() => ({
  hydrateSession: vi.fn(async (): Promise<void> => {}),
  teardownSession: vi.fn(),
  uiLoadAll: vi.fn(async (): Promise<void> => {}),
  uiClear: vi.fn(),
  treeLoad: vi.fn(async (): Promise<void> => {}),
  treeClear: vi.fn()
}))

vi.mock('../i18n', () => ({ i18next: { t: (k: string): string => k } }))
vi.mock('../lib/sessionPersistence', () => ({
  hydrateSession: h.hydrateSession,
  teardownSession: h.teardownSession
}))
vi.mock('./uiState', () => ({
  useUiStateStore: { getState: () => ({ loadAll: h.uiLoadAll, clear: h.uiClear }) }
}))
vi.mock('./treeState', () => ({
  useTreeStateStore: { getState: () => ({ load: h.treeLoad, clear: h.treeClear }) }
}))
vi.mock('./toast', () => ({ useToastStore: { getState: () => ({ push: vi.fn() }) } }))
vi.mock('./appearance', () => ({
  useAppearanceStore: { getState: () => ({ flush: async (): Promise<void> => {} }) }
}))

let store: typeof import('./workspace').useWorkspaceStore

type ActiveListener = (payload: { workspacePath: string | null }) => void

function makeMockApi(active: string | null) {
  const listeners = new Set<ActiveListener>()
  return {
    listeners,
    emit: (workspacePath: string | null): void => {
      for (const cb of listeners) cb({ workspacePath })
    },
    workspace: {
      getActive: vi.fn(async (): Promise<string | null> => active),
      getLast: vi.fn(),
      getRequestsRoot: vi.fn(async (): Promise<string> => `${active}/requests`),
      onActiveChanged: vi.fn((cb: ActiveListener) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      })
    }
  }
}

let api: ReturnType<typeof makeMockApi>

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

beforeEach(async () => {
  vi.resetModules()
  for (const fn of Object.values(h)) fn.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function setup(active: string | null): Promise<void> {
  api = makeMockApi(active)
  vi.stubGlobal('window', { api })
  store = (await import('./workspace')).useWorkspaceStore
}

describe('workspace store — followActiveWorkspace (detached Activity window, HIS-05)', () => {
  it('binds to the workspace main has open, without restoring the last one', async () => {
    await setup('/ws-a')
    store.getState().followActiveWorkspace()
    await settle()

    expect(api.workspace.getActive).toHaveBeenCalledTimes(1)
    expect(api.workspace.getLast).not.toHaveBeenCalled()
    expect(store.getState().workspacePath).toBe('/ws-a')
    expect(store.getState().requestsRoot).toBe('/ws-a/requests')
  })

  it('stays without a workspace when main has none open', async () => {
    await setup(null)
    store.getState().followActiveWorkspace()
    await settle()

    expect(store.getState().workspacePath).toBeNull()
    expect(api.workspace.getRequestsRoot).not.toHaveBeenCalled()
  })

  it('follows a switch to another workspace', async () => {
    await setup('/ws-a')
    store.getState().followActiveWorkspace()
    await settle()

    api.workspace.getRequestsRoot.mockResolvedValue('/ws-b/requests')
    api.emit('/ws-b')
    await settle()

    expect(store.getState().workspacePath).toBe('/ws-b')
    expect(store.getState().requestsRoot).toBe('/ws-b/requests')
  })

  it('clears when main closes the workspace', async () => {
    await setup('/ws-a')
    store.getState().followActiveWorkspace()
    await settle()

    api.emit(null)
    await settle()

    expect(store.getState().workspacePath).toBeNull()
    expect(store.getState().requestsRoot).toBeNull()
  })

  it('a change announced while the first read is in flight wins over that read', async () => {
    await setup('/ws-a')
    let resolveActive: (p: string | null) => void = () => {}
    api.workspace.getActive.mockReturnValueOnce(
      new Promise<string | null>((r) => {
        resolveActive = r
      })
    )
    store.getState().followActiveWorkspace()
    api.emit(null)
    await settle()
    resolveActive('/ws-a')
    await settle()

    expect(store.getState().workspacePath).toBeNull()
  })

  it('stops following once unsubscribed', async () => {
    await setup('/ws-a')
    const stop = store.getState().followActiveWorkspace()
    await settle()
    stop()

    api.emit('/ws-b')
    await settle()

    expect(api.listeners.size).toBe(0)
    expect(store.getState().workspacePath).toBe('/ws-a')
  })
})
