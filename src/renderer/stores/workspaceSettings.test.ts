import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceHttpSettings } from '../../shared/types'

// Fresh module per test so the zustand store is reset and any window-stub
// changes apply.
let store: typeof import('./workspaceSettings').useWorkspaceSettingsStore

const baseSettings: WorkspaceHttpSettings = {
  httpVersion: 'auto',
  verifySsl: true,
  followRedirects: true,
  maxRedirects: 10,
  followAuthorizationOnRedirect: false,
  encodeUrl: true,
  disableCookieJar: false
}

function makeMockApi() {
  return {
    workspace: {
      getHttpSettings: vi.fn().mockResolvedValue(baseSettings),
      updateHttpSettings: vi.fn(
        async (partial: Partial<WorkspaceHttpSettings>) =>
          ({ ...baseSettings, ...partial }) as WorkspaceHttpSettings
      )
    }
  }
}

let api: ReturnType<typeof makeMockApi>

beforeEach(async () => {
  vi.resetModules()
  api = makeMockApi()
  vi.stubGlobal('window', { api })
  const mod = await import('./workspaceSettings')
  store = mod.useWorkspaceSettingsStore
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('workspaceSettings store', () => {
  it('starts with defaults and no loaded workspace', () => {
    const s = store.getState()
    expect(s.loadedFor).toBeNull()
    expect(s.isLoading).toBe(false)
    expect(s.httpSettings.followRedirects).toBe(true)
  })

  it('load() reads from the IPC and records loadedFor', async () => {
    await store.getState().load('/tmp/ws')
    // The path is no longer sent over IPC — the main resolves the active
    // workspace itself. The store still records loadedFor for its own bookkeeping.
    expect(api.workspace.getHttpSettings).toHaveBeenCalledWith()
    expect(store.getState().loadedFor).toBe('/tmp/ws')
    expect(store.getState().isLoading).toBe(false)
  })

  it('load() clears isLoading even if the IPC throws', async () => {
    api.workspace.getHttpSettings.mockRejectedValueOnce(new Error('boom'))
    await expect(store.getState().load('/tmp/ws')).rejects.toThrow('boom')
    expect(store.getState().isLoading).toBe(false)
  })

  it('update() forwards the partial and overwrites the cached settings', async () => {
    await store.getState().update({ followRedirects: false, maxRedirects: 3 })
    expect(api.workspace.updateHttpSettings).toHaveBeenCalledWith({
      followRedirects: false,
      maxRedirects: 3
    })
    expect(store.getState().httpSettings.followRedirects).toBe(false)
    expect(store.getState().httpSettings.maxRedirects).toBe(3)
  })

  it('resetToDefaults() sends the full default object', async () => {
    await store.getState().resetToDefaults()
    expect(api.workspace.updateHttpSettings).toHaveBeenCalledTimes(1)
    const [payload] = api.workspace.updateHttpSettings.mock.calls[0]!
    expect(payload).toMatchObject({
      httpVersion: 'auto',
      verifySsl: true,
      followRedirects: true
    })
  })

  // The applyExternal contract: REQ-0055 §4.3.6 specifically calls out
  // "applyExternal sin re-trigger de write". A future regression that wires
  // an IPC write into applyExternal would show up here as an extra mock
  // call on updateHttpSettings.
  it('applyExternal() updates the in-memory cache without calling the IPC', () => {
    const broadcast: WorkspaceHttpSettings = { ...baseSettings, verifySsl: false }
    store.getState().applyExternal(broadcast)
    expect(store.getState().httpSettings.verifySsl).toBe(false)
    expect(api.workspace.updateHttpSettings).not.toHaveBeenCalled()
    expect(api.workspace.getHttpSettings).not.toHaveBeenCalled()
  })

  it('applyExternal() does not modify loadedFor', () => {
    store.setState({ loadedFor: '/tmp/ws-old' })
    store.getState().applyExternal({ ...baseSettings, encodeUrl: false })
    expect(store.getState().loadedFor).toBe('/tmp/ws-old')
  })

  // REQ-0065: changing binaryFileLimits in window A broadcasts via
  // `workspace:httpSettingsChanged`; window B's applyExternal picks it up.
  it('applyExternal() propagates a new binaryFileLimits without IPC re-trigger', () => {
    const broadcast: WorkspaceHttpSettings = {
      ...baseSettings,
      binaryFileLimits: { warnBytes: 1024 * 1024, blockBytes: 2 * 1024 * 1024 }
    }
    store.getState().applyExternal(broadcast)
    expect(store.getState().httpSettings.binaryFileLimits).toEqual({
      warnBytes: 1024 * 1024,
      blockBytes: 2 * 1024 * 1024
    })
    expect(api.workspace.updateHttpSettings).not.toHaveBeenCalled()
  })
})
