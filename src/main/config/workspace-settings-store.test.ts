import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Stub electron.BrowserWindow.getAllWindows so the broadcast does not crash
// outside the desktop runtime. `vi.hoisted` lets a single mock function be
// shared between the module-level mock and individual tests that need to
// stage a list of fake BrowserWindow instances.
const { getAllWindowsMock } = vi.hoisted(() => ({
  getAllWindowsMock: vi.fn<() => unknown[]>(() => [])
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: getAllWindowsMock }
}))

// The store reaches core I/O through the workspace handle. Mock `openWorkspace`
// to return a settings façade backed by shared mock fns, so assertions can check
// the patch passed to `settings.update` (the path is captured by `openWorkspace`).
const { openWorkspaceMock, updateMock } = vi.hoisted(() => {
  const updateMock = vi.fn()
  return {
    updateMock,
    openWorkspaceMock: vi.fn((_path: string) => ({
      settings: { load: vi.fn(), update: updateMock }
    }))
  }
})

vi.mock('@fetchpier/core', () => ({
  workspace: {
    DEFAULT_WORKSPACE_HTTP_SETTINGS: {
      httpVersion: 'auto',
      verifySsl: true,
      followRedirects: true,
      maxRedirects: 10,
      followAuthorizationOnRedirect: false,
      encodeUrl: true,
      disableCookieJar: false,
      binaryFileLimits: { warnBytes: 52428800, blockBytes: 104857600 }
    },
    openWorkspace: openWorkspaceMock
  }
}))

import { updateHttpSettings } from './workspace-settings-store'

const RESULT = {
  httpVersion: 'auto' as const,
  verifySsl: true,
  followRedirects: true,
  maxRedirects: 10,
  followAuthorizationOnRedirect: false,
  encodeUrl: true,
  disableCookieJar: false,
  binaryFileLimits: { warnBytes: 1024, blockBytes: 2048 }
}

describe('workspace-settings-store — binaryFileLimits validation', () => {
  beforeEach(() => {
    updateMock.mockResolvedValue(RESULT)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('persists a valid binaryFileLimits patch via the handle', async () => {
    await expect(
      updateHttpSettings('/ws', {
        binaryFileLimits: { warnBytes: 1024, blockBytes: 2048 }
      })
    ).resolves.toBeDefined()
    expect(openWorkspaceMock).toHaveBeenCalledWith('/ws')
    expect(updateMock).toHaveBeenCalledWith({
      binaryFileLimits: { warnBytes: 1024, blockBytes: 2048 }
    })
  })

  it('rejects negative warn/block thresholds', async () => {
    await expect(
      updateHttpSettings('/ws', {
        binaryFileLimits: { warnBytes: -1, blockBytes: 1024 }
      })
    ).rejects.toThrow(/≥ 0/)
    await expect(
      updateHttpSettings('/ws', {
        binaryFileLimits: { warnBytes: 1, blockBytes: -1 }
      })
    ).rejects.toThrow(/≥ 0/)
    expect(updateMock).not.toHaveBeenCalled()
  })

  it('rejects when warn > block', async () => {
    await expect(
      updateHttpSettings('/ws', {
        binaryFileLimits: { warnBytes: 2048, blockBytes: 1024 }
      })
    ).rejects.toThrow(/warnBytes must be ≤ blockBytes/)
    expect(updateMock).not.toHaveBeenCalled()
  })

  it('rejects non-finite values', async () => {
    await expect(
      updateHttpSettings('/ws', {
        binaryFileLimits: { warnBytes: Number.NaN, blockBytes: 1024 }
      })
    ).rejects.toThrow(/finite/)
  })
})

describe('workspace-settings-store — cross-window broadcast', () => {
  beforeEach(() => {
    updateMock.mockResolvedValue(RESULT)
  })

  afterEach(() => {
    vi.clearAllMocks()
    getAllWindowsMock.mockReturnValue([])
  })

  it('broadcasts workspace:httpSettingsChanged to every live window on update', async () => {
    const send1 = vi.fn()
    const send2 = vi.fn()
    const w1 = { isDestroyed: vi.fn(() => false), webContents: { send: send1 } }
    const w2 = { isDestroyed: vi.fn(() => false), webContents: { send: send2 } }
    getAllWindowsMock.mockReturnValue([w1, w2])

    const next = await updateHttpSettings('/ws', {
      binaryFileLimits: { warnBytes: 1024, blockBytes: 2048 }
    })

    expect(send1).toHaveBeenCalledTimes(1)
    expect(send1).toHaveBeenCalledWith('workspace:httpSettingsChanged', next)
    expect(send2).toHaveBeenCalledTimes(1)
    expect(send2).toHaveBeenCalledWith('workspace:httpSettingsChanged', next)
  })

  it('skips destroyed windows on broadcast', async () => {
    const sendLive = vi.fn()
    const sendDead = vi.fn()
    const live = { isDestroyed: vi.fn(() => false), webContents: { send: sendLive } }
    const dead = { isDestroyed: vi.fn(() => true), webContents: { send: sendDead } }
    getAllWindowsMock.mockReturnValue([live, dead])

    await updateHttpSettings('/ws', {
      binaryFileLimits: { warnBytes: 1024, blockBytes: 2048 }
    })

    expect(sendLive).toHaveBeenCalledTimes(1)
    expect(sendDead).not.toHaveBeenCalled()
  })
})
