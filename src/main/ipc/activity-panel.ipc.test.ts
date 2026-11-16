/**
 * Tests for the activity-panel IPC handlers. We stub electron's BrowserWindow
 * + ipcMain + webContents because the handlers are pure orchestration: they
 * track a module-singleton popout window and broadcast to the OWNING main
 * window only. The window-construction path is exercised separately at runtime;
 * here we want to lock the routing invariants.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: { sender: { id: number } }, ...args: unknown[]) => unknown

interface FakeWindow {
  id: number
  webContents: {
    id: number
    isDestroyed: () => boolean
    send: ReturnType<typeof vi.fn>
  }
  isDestroyed: () => boolean
  close: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
  isMinimized: () => boolean
  restore: ReturnType<typeof vi.fn>
  on: (event: string, cb: () => void) => void
  __emit: (event: string) => void
  __listeners: Record<string, Array<() => void>>
}

const handlers = new Map<string, Handler>()
const createdWindows: FakeWindow[] = []
let nextWindowId = 100
let webContentsByOwner: Map<number, FakeWindow['webContents']> = new Map()

interface FakeOwnerWindow {
  isDestroyed: () => boolean
  isMinimized: ReturnType<typeof vi.fn>
  restore: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
}
/** Owner BrowserWindows by webContents id, for the bring-to-front checks. */
const ownerWindows = new Map<number, FakeOwnerWindow>()

// `resolveInsideActiveWorkspace` stand-in: throws like the real one when there
// is no active workspace or the path escapes it.
const resolveInside = vi.hoisted(() => ({
  fn: vi.fn((rel: string): string => `/ws/${rel}`)
}))
vi.mock('../fs/safe-path', () => ({
  resolveInsideActiveWorkspace: (rel: string) => resolveInside.fn(rel)
}))

function makeFakeWindow(): FakeWindow {
  const id = nextWindowId++
  const listeners: Record<string, Array<() => void>> = {}
  const wc = {
    id,
    isDestroyed: vi.fn(() => false),
    send: vi.fn()
  }
  const win: FakeWindow = {
    id,
    webContents: wc,
    isDestroyed: vi.fn(() => false),
    close: vi.fn(() => {
      ;(listeners['close'] ?? []).forEach((cb) => cb())
      ;(listeners['closed'] ?? []).forEach((cb) => cb())
    }),
    focus: vi.fn(),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    on: (event, cb) => {
      ;(listeners[event] ??= []).push(cb)
    },
    __emit: (event) => {
      ;(listeners[event] ?? []).forEach((cb) => cb())
    },
    __listeners: listeners
  }
  return win
}

vi.mock('electron', () => {
  return {
    BrowserWindow: {
      fromWebContents: (wc: { id: number }) => {
        // A stand-in main window with matching id: passed to
        // createActivityPanelWindow as `parent` (mocked below), and brought to
        // the front by `activityPanel:openInOwner`.
        return ownerWindows.get(wc.id) ?? { webContents: wc, id: wc.id }
      }
    },
    ipcMain: {
      handle: (channel: string, fn: Handler) => {
        handlers.set(channel, fn)
      }
    },
    webContents: {
      fromId: (id: number) => webContentsByOwner.get(id) ?? null
    },
    nativeTheme: { shouldUseDarkColors: false }
  }
})

vi.mock('../window/create-activity-panel-window', () => ({
  createActivityPanelWindow: (..._args: unknown[]) => {
    const win = makeFakeWindow()
    createdWindows.push(win)
    return win
  }
}))

let mod: typeof import('./activity-panel.ipc')

beforeEach(async () => {
  handlers.clear()
  createdWindows.length = 0
  webContentsByOwner = new Map()
  ownerWindows.clear()
  resolveInside.fn.mockReset()
  resolveInside.fn.mockImplementation((rel: string): string => `/ws/${rel}`)
  vi.resetModules()
  mod = await import('./activity-panel.ipc')
  mod.registerActivityPanelHandlers()
})

afterEach(() => {
  mod.__resetActivityPanelState()
  vi.clearAllMocks()
})

function registerOwner(senderId: number): { sender: { id: number } } {
  const wc = {
    id: senderId,
    isDestroyed: () => false,
    send: vi.fn()
  } as unknown as FakeWindow['webContents']
  webContentsByOwner.set(senderId, wc)
  return { sender: { id: senderId } }
}

describe('activity-panel IPC handlers', () => {
  it('registers the five expected channels', () => {
    expect(handlers.has('activityPanel:popout')).toBe(true)
    expect(handlers.has('activityPanel:dock')).toBe(true)
    expect(handlers.has('activityPanel:focusPopout')).toBe(true)
    expect(handlers.has('activityPanel:isPoppedOut')).toBe(true)
    expect(handlers.has('activityPanel:openInOwner')).toBe(true)
  })

  it('popout creates a window and broadcasts detached=true to the owner only', async () => {
    const event = registerOwner(42)
    const result = (await handlers.get('activityPanel:popout')!(event)) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(createdWindows).toHaveLength(1)
    const ownerWc = webContentsByOwner.get(42)!
    expect(ownerWc.send).toHaveBeenCalledWith('activity-panel:popout-changed', {
      detached: true
    })
  })

  it('a second popout from a different owner is rejected', async () => {
    registerOwner(42)
    await handlers.get('activityPanel:popout')!(registerOwner(42))
    const second = (await handlers.get('activityPanel:popout')!(registerOwner(99))) as {
      ok: boolean
      reason?: string
    }
    expect(second.ok).toBe(false)
    expect(second.reason).toBe('already-detached')
    expect(createdWindows).toHaveLength(1)
  })

  it('dock closes the popout and broadcasts detached=false, openAfter=true', async () => {
    await handlers.get('activityPanel:popout')!(registerOwner(42))
    const ownerWc = webContentsByOwner.get(42)!
    ownerWc.send.mockClear()

    const result = (await handlers.get('activityPanel:dock')!({ sender: { id: 42 } })) as {
      ok: boolean
    }
    expect(result.ok).toBe(true)
    expect(createdWindows[0]!.close).toHaveBeenCalledTimes(1)
    expect(ownerWc.send).toHaveBeenCalledWith('activity-panel:popout-changed', {
      detached: false,
      openAfter: true
    })
  })

  it('user-initiated close (without dock) broadcasts detached=false, openAfter=false', async () => {
    await handlers.get('activityPanel:popout')!(registerOwner(42))
    const ownerWc = webContentsByOwner.get(42)!
    ownerWc.send.mockClear()

    // Simulate the OS X button: the close event fires, the handler hasn't
    // cleared the singleton yet.
    createdWindows[0]!.__emit('close')
    expect(ownerWc.send).toHaveBeenCalledWith('activity-panel:popout-changed', {
      detached: false,
      openAfter: false
    })
  })

  it('isPoppedOut reflects current singleton state', async () => {
    const before = await handlers.get('activityPanel:isPoppedOut')!({
      sender: { id: 0 }
    })
    expect(before).toBe(false)
    await handlers.get('activityPanel:popout')!(registerOwner(42))
    const after = await handlers.get('activityPanel:isPoppedOut')!({ sender: { id: 0 } })
    expect(after).toBe(true)
  })

  it('focusPopout calls win.focus() and returns true when a popout exists', async () => {
    await handlers.get('activityPanel:popout')!(registerOwner(42))
    const result = await handlers.get('activityPanel:focusPopout')!({ sender: { id: 0 } })
    expect(result).toBe(true)
    expect(createdWindows[0]!.focus).toHaveBeenCalledTimes(1)
  })

  it('focusPopout returns false when no popout exists', async () => {
    const result = await handlers.get('activityPanel:focusPopout')!({ sender: { id: 0 } })
    expect(result).toBe(false)
  })

  it('dock does not throw when no popout exists', async () => {
    const result = (await handlers.get('activityPanel:dock')!({ sender: { id: 0 } })) as {
      ok: boolean
    }
    expect(result.ok).toBe(true)
  })

  it('after dock-and-close, a new popout from a different owner is accepted', async () => {
    await handlers.get('activityPanel:popout')!(registerOwner(42))
    await handlers.get('activityPanel:dock')!({ sender: { id: 42 } })
    // 'closed' fires after close() in our fake window — the handler clears the
    // singleton there.
    const result = (await handlers.get('activityPanel:popout')!(registerOwner(99))) as {
      ok: boolean
    }
    expect(result.ok).toBe(true)
    expect(createdWindows).toHaveLength(2)
  })
})

// ISS-0164: a History row action taken in the popout runs in the main window
// that owns it, which comes to the front.
describe('activityPanel:openInOwner', () => {
  const VIEW = { kind: 'view', entryId: 'run-1' }

  async function popOut(ownerId = 42): Promise<{
    popoutEvent: { sender: { id: number } }
    ownerWc: FakeWindow['webContents']
    ownerWin: FakeOwnerWindow
  }> {
    const ownerWin: FakeOwnerWindow = {
      isDestroyed: () => false,
      isMinimized: vi.fn(() => false),
      restore: vi.fn(),
      focus: vi.fn()
    }
    ownerWindows.set(ownerId, ownerWin)
    await handlers.get('activityPanel:popout')!(registerOwner(ownerId))
    const ownerWc = webContentsByOwner.get(ownerId)!
    ownerWc.send.mockClear()
    return { popoutEvent: { sender: { id: createdWindows[0]!.webContents.id } }, ownerWc, ownerWin }
  }

  function openInOwner(event: { sender: { id: number } }, payload: unknown): unknown {
    return handlers.get('activityPanel:openInOwner')!(event, payload)
  }

  it('forwards the action to the owner only and brings it to the front', async () => {
    const { popoutEvent, ownerWc, ownerWin } = await popOut()
    expect(await openInOwner(popoutEvent, VIEW)).toBe(true)
    expect(ownerWc.send).toHaveBeenCalledWith('activity-panel:row-action', VIEW)
    expect(createdWindows[0]!.webContents.send).not.toHaveBeenCalled()
    expect(ownerWin.focus).toHaveBeenCalledTimes(1)
    expect(ownerWin.restore).not.toHaveBeenCalled()
  })

  it('restores a minimized owner before focusing it', async () => {
    const { popoutEvent, ownerWin } = await popOut()
    ownerWin.isMinimized.mockReturnValue(true)
    await openInOwner(popoutEvent, VIEW)
    expect(ownerWin.restore).toHaveBeenCalledTimes(1)
    expect(ownerWin.focus).toHaveBeenCalledTimes(1)
  })

  it('forwards the validated copy, not the payload as sent', async () => {
    const { popoutEvent, ownerWc } = await popOut()
    await openInOwner(popoutEvent, { ...VIEW, extra: 'x' })
    expect(ownerWc.send).toHaveBeenCalledWith('activity-panel:row-action', VIEW)
  })

  it('a source file is checked inside the active workspace before it is forwarded', async () => {
    const { popoutEvent, ownerWc } = await popOut()
    const action = { kind: 'open-source-file', sourceFile: 'requests/a.http' }
    expect(await openInOwner(popoutEvent, action)).toBe(true)
    expect(resolveInside.fn).toHaveBeenCalledWith('requests/a.http')
    expect(ownerWc.send).toHaveBeenCalledWith('activity-panel:row-action', action)
  })

  it.each([
    ['a sender other than the popout (the owner itself)', 'owner'],
    ['an unrelated sender', 'other']
  ])('refuses %s', async (_label, who) => {
    const { ownerWc } = await popOut()
    const event = who === 'owner' ? { sender: { id: 42 } } : { sender: { id: 7 } }
    expect(await openInOwner(event, VIEW)).toBe(false)
    expect(ownerWc.send).not.toHaveBeenCalled()
  })

  it('refuses an invalid payload', async () => {
    const { popoutEvent, ownerWc } = await popOut()
    expect(await openInOwner(popoutEvent, { kind: 'delete', entryId: 'run-1' })).toBe(false)
    expect(await openInOwner(popoutEvent, null)).toBe(false)
    expect(ownerWc.send).not.toHaveBeenCalled()
  })

  it('refuses a source file the active workspace does not contain (or with none open)', async () => {
    const { popoutEvent, ownerWc } = await popOut()
    resolveInside.fn.mockImplementation(() => {
      throw new Error('Path escapes workspace')
    })
    const action = { kind: 'open-source-file', sourceFile: 'requests/a.http' }
    expect(await openInOwner(popoutEvent, action)).toBe(false)
    expect(ownerWc.send).not.toHaveBeenCalled()
  })

  it('refuses when no popout exists', async () => {
    registerOwner(42)
    expect(await openInOwner({ sender: { id: 100 } }, VIEW)).toBe(false)
  })

  it('refuses when the owner is gone', async () => {
    const { popoutEvent, ownerWc } = await popOut()
    ;(ownerWc as unknown as { isDestroyed: () => boolean }).isDestroyed = () => true
    expect(await openInOwner(popoutEvent, VIEW)).toBe(false)
    expect(ownerWc.send).not.toHaveBeenCalled()
  })
})
