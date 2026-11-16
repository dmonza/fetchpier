/**
 * workspace-state IPC: the open-tab session is written only by the main
 * window (ISS-0164). The detached Activity window shares the preload, so a
 * session write from it must not replace the main window's session.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: { sender: { id: number } }, ...args: unknown[]) => unknown

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: { sender: { id: number } }, ...args: unknown[]) => unknown>(),
  setSession: vi.fn(),
  setActiveEnvironment: vi.fn(),
  getView: vi.fn(),
  mainWindowContentsId: null as number | null
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      h.handlers.set(channel, fn)
    }
  }
}))

vi.mock('../state/workspace-state-store', () => ({
  getView: h.getView,
  setSession: h.setSession,
  setActiveEnvironment: h.setActiveEnvironment
}))

vi.mock('./window.ipc', () => ({
  isMainWindowSender: (sender: { id: number }): boolean =>
    h.mainWindowContentsId !== null && sender.id === h.mainWindowContentsId
}))

import { registerWorkspaceStateHandlers } from './workspace-state.ipc'

const MAIN = { sender: { id: 1 } }
const POPOUT = { sender: { id: 2 } }
const SESSION = { tabs: [{ kind: 'request', path: '/ws/requests/a.http' }], activeTabIndex: 0 }

function setSession(event: { sender: { id: number } }, payload: unknown): unknown {
  return h.handlers.get('workspace-state:setSession')!(event, payload)
}

beforeEach(() => {
  h.handlers.clear()
  h.setSession.mockReset()
  h.mainWindowContentsId = MAIN.sender.id
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  registerWorkspaceStateHandlers()
})

describe('workspace-state:setSession — main window only', () => {
  it("writes the main window's session", async () => {
    await setSession(MAIN, SESSION)
    expect(h.setSession).toHaveBeenCalledWith(SESSION.tabs, 0)
  })

  it('ignores a session from any other window, without throwing', async () => {
    await expect(setSession(POPOUT, SESSION)).resolves.toBeUndefined()
    expect(h.setSession).not.toHaveBeenCalled()
  })

  it('ignores every session while no main window is registered', async () => {
    h.mainWindowContentsId = null
    await setSession(MAIN, SESSION)
    expect(h.setSession).not.toHaveBeenCalled()
  })

  it('logs a refused write without the session it carried', async () => {
    await setSession(POPOUT, SESSION)
    const logged = vi.mocked(console.warn).mock.calls.flat().join(' ')
    expect(logged).toContain('workspace-state:setSession')
    expect(logged).not.toContain('a.http')
  })

  it('still normalizes a malformed payload from the main window', async () => {
    await setSession(MAIN, { tabs: 'nope', activeTabIndex: 'x' })
    expect(h.setSession).toHaveBeenCalledWith([], -1)
    h.setSession.mockClear()
    await setSession(MAIN, null)
    expect(h.setSession).not.toHaveBeenCalled()
  })
})
