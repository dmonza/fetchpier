import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceSessionTab, WorkspaceStateView } from '../../shared/types'

type SessionArg = { tabs: WorkspaceSessionTab[]; activeTabIndex: number }

// Mocks for the workspace-state IPC surface. Re-created per test so call
// history is isolated.
const readMock = vi.fn<() => Promise<WorkspaceStateView>>()
const setSessionMock = vi.fn<(session: SessionArg) => Promise<void>>()
const setActiveEnvironmentMock = vi.fn<(id: string | null) => Promise<void>>()

let mod: typeof import('./sessionPersistence')
let store: typeof import('../stores/request').useRequestStore

function emptyView(): WorkspaceStateView {
  return { activeEnvironmentId: null, session: { tabs: [], activeTabIndex: -1 } }
}

beforeEach(async () => {
  vi.resetModules()
  readMock.mockReset()
  readMock.mockResolvedValue(emptyView())
  setSessionMock.mockReset()
  setSessionMock.mockResolvedValue(undefined)
  setActiveEnvironmentMock.mockReset()
  setActiveEnvironmentMock.mockResolvedValue(undefined)
  vi.stubGlobal('window', {
    api: {
      workspaceState: {
        read: readMock,
        setSession: setSessionMock,
        setActiveEnvironment: setActiveEnvironmentMock
      }
    }
  })
  mod = await import('./sessionPersistence')
  store = (await import('../stores/request')).useRequestStore
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('hydrateSession — restore (CA-03/04/06/10)', () => {
  it('restores the persisted file-backed tabs in order with the active index', async () => {
    readMock.mockResolvedValue({
      activeEnvironmentId: 'env-dev',
      session: {
        tabs: [
          { kind: 'request', path: '/ws/requests/a.http' },
          { kind: 'request', path: '/ws/requests/b.http' },
          { kind: 'request', path: '/ws/requests/c.http' }
        ],
        activeTabIndex: 1
      }
    })
    await mod.hydrateSession('/ws')
    const s = store.getState()
    expect(s.tabs.map((t) => t.filePath)).toEqual([
      '/ws/requests/a.http',
      '/ws/requests/b.http',
      '/ws/requests/c.http'
    ])
    expect(s.activeTabId).toBe(s.tabs[1].id)
  })

  it('an empty persisted session restores the empty state', async () => {
    readMock.mockResolvedValue(emptyView())
    await mod.hydrateSession('/ws')
    expect(store.getState().tabs).toHaveLength(0)
    expect(store.getState().activeTabId).toBeNull()
  })

  it('restoring does not immediately write the seed back', async () => {
    readMock.mockResolvedValue({
      activeEnvironmentId: null,
      session: { tabs: [{ kind: 'request', path: '/ws/requests/a.http' }], activeTabIndex: 0 }
    })
    await mod.hydrateSession('/ws')
    expect(setSessionMock).not.toHaveBeenCalled()
  })

  it('a read failure degrades to the empty state (CA-09 at the renderer)', async () => {
    readMock.mockRejectedValue(new Error('corrupt'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await mod.hydrateSession('/ws')
    expect(store.getState().tabs).toHaveLength(0)
    err.mockRestore()
  })
})

describe('session write subscription (CA-05)', () => {
  it('persists only file-backed tabs, excluding untitled and history tabs', async () => {
    await mod.hydrateSession('/ws')
    setSessionMock.mockClear()

    store.getState().openTab({ title: 'file', filePath: '/ws/requests/a.http' })
    store.getState().openTab({ title: 'scratch' }) // untitled → not persisted
    store.getState().openTab({
      title: 'hist',
      isReadOnly: true,
      historyEntryId: 'h1'
    }) // history → not persisted

    const lastCall = setSessionMock.mock.calls.at(-1)?.[0]
    expect(lastCall?.tabs).toEqual([{ kind: 'request', path: '/ws/requests/a.http' }])
  })

  it('reports activeTabIndex of -1 when the active tab is not file-backed', async () => {
    await mod.hydrateSession('/ws')
    store.getState().openTab({ title: 'file', filePath: '/ws/requests/a.http' })
    store.getState().openTab({ title: 'scratch' }) // active, untitled

    const lastCall = setSessionMock.mock.calls.at(-1)?.[0]
    expect(lastCall?.tabs).toEqual([{ kind: 'request', path: '/ws/requests/a.http' }])
    expect(lastCall?.activeTabIndex).toBe(-1)
  })

  it('persists active-tab changes', async () => {
    await mod.hydrateSession('/ws')
    store.getState().openTab({ title: 'a', filePath: '/ws/requests/a.http' })
    store.getState().openTab({ title: 'b', filePath: '/ws/requests/b.http' })
    setSessionMock.mockClear()

    const firstId = store.getState().tabs[0].id
    store.getState().setActiveTab(firstId)
    const lastCall = setSessionMock.mock.calls.at(-1)?.[0]
    expect(lastCall?.activeTabIndex).toBe(0)
  })

  it('does not write content edits that leave the session shape unchanged', async () => {
    await mod.hydrateSession('/ws')
    store.getState().openTab({ title: 'a', filePath: '/ws/requests/a.http' })
    const id = store.getState().tabs[0].id
    setSessionMock.mockClear()

    store.getState().updateRequest(id, { method: 'POST' })
    expect(setSessionMock).not.toHaveBeenCalled()
  })
})

describe('tab mode marker (preview / pinned)', () => {
  it('persists mode:preview for a tab opened in the preview slot (CA-08 write)', async () => {
    await mod.hydrateSession('/ws')
    setSessionMock.mockClear()

    store.getState().openPreviewTab({ title: 'a', filePath: '/ws/requests/a.http' })

    const lastCall = setSessionMock.mock.calls.at(-1)?.[0]
    expect(lastCall?.tabs).toEqual([
      { kind: 'request', path: '/ws/requests/a.http', mode: 'preview' }
    ])
  })

  it('persists mode:pinned for a pinned tab', async () => {
    await mod.hydrateSession('/ws')
    store.getState().openTab({ title: 'a', filePath: '/ws/requests/a.http' })
    const id = store.getState().tabs[0].id
    setSessionMock.mockClear()

    store.getState().pinTab(id)

    const lastCall = setSessionMock.mock.calls.at(-1)?.[0]
    expect(lastCall?.tabs).toEqual([
      { kind: 'request', path: '/ws/requests/a.http', mode: 'pinned' }
    ])
  })

  it('omits the marker once the tab is promoted (permanent ⇒ no mode field)', async () => {
    await mod.hydrateSession('/ws')
    store.getState().openPreviewTab({ title: 'a', filePath: '/ws/requests/a.http' })
    const id = store.getState().tabs[0].id
    setSessionMock.mockClear()

    store.getState().promoteTab(id)

    const lastCall = setSessionMock.mock.calls.at(-1)?.[0]
    expect(lastCall?.tabs).toEqual([{ kind: 'request', path: '/ws/requests/a.http' }])
  })

  it('restores a persisted preview / pinned tab by its mode (CA-08 restore)', async () => {
    readMock.mockResolvedValue({
      activeEnvironmentId: null,
      session: {
        tabs: [
          { kind: 'request', path: '/ws/requests/a.http' },
          { kind: 'request', path: '/ws/requests/b.http', mode: 'preview' },
          { kind: 'request', path: '/ws/requests/c.http', mode: 'pinned' }
        ],
        activeTabIndex: 0
      }
    })
    await mod.hydrateSession('/ws')
    const byPath = (p: string): ReturnType<typeof store.getState>['tabs'][number] | undefined =>
      store.getState().tabs.find((t) => t.filePath === p)
    expect(byPath('/ws/requests/a.http')?.mode).toBe('permanent')
    expect(byPath('/ws/requests/b.http')?.mode).toBe('preview')
    expect(byPath('/ws/requests/c.http')?.mode).toBe('pinned')
  })

  it('a session with no markers restores all tabs permanent (back-compat)', async () => {
    readMock.mockResolvedValue({
      activeEnvironmentId: null,
      session: {
        tabs: [
          { kind: 'request', path: '/ws/requests/a.http' },
          { kind: 'request', path: '/ws/requests/b.http' }
        ],
        activeTabIndex: 0
      }
    })
    await mod.hydrateSession('/ws')
    expect(store.getState().tabs.every((t) => t.mode === 'permanent')).toBe(true)
  })
})

describe('teardownSession', () => {
  it('clears tabs and stops writing on subsequent changes', async () => {
    await mod.hydrateSession('/ws')
    store.getState().openTab({ title: 'a', filePath: '/ws/requests/a.http' })
    mod.teardownSession()
    expect(store.getState().tabs).toHaveLength(0)

    setSessionMock.mockClear()
    store.getState().openTab({ title: 'b', filePath: '/ws/requests/b.http' })
    expect(setSessionMock).not.toHaveBeenCalled()
  })
})
