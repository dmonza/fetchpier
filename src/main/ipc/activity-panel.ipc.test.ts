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
        // Return a stand-in main window with matching id; not used by the IPC
        // module beyond being passed to createActivityPanelWindow as `parent`,
        // which we mock below.
        return { webContents: wc, id: wc.id }
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
  it('registers the four expected channels', () => {
    expect(handlers.has('activityPanel:popout')).toBe(true)
    expect(handlers.has('activityPanel:dock')).toBe(true)
    expect(handlers.has('activityPanel:focusPopout')).toBe(true)
    expect(handlers.has('activityPanel:isPoppedOut')).toBe(true)
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
