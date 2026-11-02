/**
 * Close-guard fallback (REQ-0104). The guard intercepts every close/quit
 * attempt and waits for the renderer's ack (`window:close-ack`, sent
 * immediately) to clear a short fallback timer, independently of however long
 * the user's later Save/Discard/Cancel decision (`window:close-confirmed`)
 * takes. If no ack ever arrives, a native dialog offers to close anyway.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, ...args: unknown[]) => unknown

interface FakeWindow {
  isDestroyed: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  minimize: ReturnType<typeof vi.fn>
  maximize: ReturnType<typeof vi.fn>
  unmaximize: ReturnType<typeof vi.fn>
  isMaximized: ReturnType<typeof vi.fn>
  setTitle: ReturnType<typeof vi.fn>
  webContents: { send: ReturnType<typeof vi.fn> }
  on: (event: string, cb: (...a: unknown[]) => void) => void
  __emit: (event: string, ...a: unknown[]) => void
}

function makeFakeWindow(): FakeWindow {
  const listeners: Record<string, Array<(...a: unknown[]) => void>> = {}
  return {
    isDestroyed: vi.fn(() => false),
    close: vi.fn(),
    minimize: vi.fn(),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    isMaximized: vi.fn(() => false),
    setTitle: vi.fn(),
    webContents: { send: vi.fn() },
    on: (event, cb) => {
      ;(listeners[event] ??= []).push(cb)
    },
    __emit: (event, ...a) => {
      ;(listeners[event] ?? []).forEach((cb) => cb(...a))
    }
  }
}

const ipcHandlers = new Map<string, Handler>()
const ipcOnHandlers = new Map<string, Handler>()
const appListeners: Record<string, Array<(event: { preventDefault: () => void }) => void>> = {}
const showMessageBox = vi.fn()
const appQuit = vi.fn()

vi.mock('electron', () => ({
  ipcMain: {
    // Mirrors real Electron: `.handle` throws on a duplicate channel, `.on`
    // behaves like a normal EventEmitter (last-registered wins here, which is
    // enough to detect an unguarded re-registration).
    handle: (channel: string, fn: Handler) => {
      if (ipcHandlers.has(channel)) {
        throw new Error(`Attempted to register a second handler for '${channel}'`)
      }
      ipcHandlers.set(channel, fn)
    },
    on: (channel: string, fn: Handler) => ipcOnHandlers.set(channel, fn)
  },
  app: {
    on: (event: string, cb: (event: { preventDefault: () => void }) => void) => {
      ;(appListeners[event] ??= []).push(cb)
    },
    quit: () => appQuit(),
    getVersion: () => '0.0.0-test'
  },
  dialog: { showMessageBox: (...args: unknown[]) => showMessageBox(...args) },
  shell: { openExternal: vi.fn() },
  BrowserWindow: {}
}))

let mod: typeof import('./window.ipc')

function emitClose(win: FakeWindow): { preventDefault: ReturnType<typeof vi.fn> } {
  const event = { preventDefault: vi.fn() }
  win.__emit('close', event)
  return event
}

function ack(): void {
  ipcOnHandlers.get('window:close-ack')!({})
}

beforeEach(async () => {
  ipcHandlers.clear()
  ipcOnHandlers.clear()
  for (const k of Object.keys(appListeners)) delete appListeners[k]
  showMessageBox.mockReset()
  appQuit.mockReset()
  vi.useFakeTimers()
  vi.resetModules()
  mod = await import('./window.ipc')
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('window.ipc — close guard fallback', () => {
  it('renderer acks and confirms before the timeout — no dialog, window closes', async () => {
    const win = makeFakeWindow()
    mod.registerWindowHandlers(win as never)

    const event = emitClose(win)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(win.webContents.send).toHaveBeenCalledWith('window:before-close')

    ack()
    await vi.advanceTimersByTimeAsync(5000)
    expect(showMessageBox).not.toHaveBeenCalled()

    await ipcHandlers.get('window:close-confirmed')!({})
    expect(win.close).toHaveBeenCalledTimes(1)
  })

  it('CA-03: ack arrives, then the user deliberates past the timeout — no fallback dialog', async () => {
    const win = makeFakeWindow()
    mod.registerWindowHandlers(win as never)

    emitClose(win)
    ack()
    await vi.advanceTimersByTimeAsync(10_000) // well past the fallback timeout
    expect(showMessageBox).not.toHaveBeenCalled()

    // the user's decision resolves late — still closes normally
    await ipcHandlers.get('window:close-confirmed')!({})
    expect(win.close).toHaveBeenCalledTimes(1)
  })

  it('CA-01: no ack arrives — fallback dialog appears; Close Anyway force-closes', async () => {
    showMessageBox.mockResolvedValue({ response: 1 }) // closeAnyway
    const win = makeFakeWindow()
    mod.registerWindowHandlers(win as never)

    emitClose(win)
    await vi.advanceTimersByTimeAsync(3000)
    expect(showMessageBox).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    await Promise.resolve()
    expect(win.close).toHaveBeenCalledTimes(1)
  })

  it('CA-04: a late close-confirmed after a forced close is a no-op', async () => {
    showMessageBox.mockResolvedValue({ response: 1 }) // closeAnyway
    const win = makeFakeWindow()
    mod.registerWindowHandlers(win as never)

    emitClose(win)
    await vi.advanceTimersByTimeAsync(3000)
    await Promise.resolve()
    await Promise.resolve()
    expect(win.close).toHaveBeenCalledTimes(1)

    win.close.mockClear()
    await ipcHandlers.get('window:close-confirmed')!({})
    expect(win.close).not.toHaveBeenCalled()
  })

  it('CA-05: Keep Waiting leaves the window open; a fresh close attempt re-arms a full guard', async () => {
    showMessageBox.mockResolvedValue({ response: 0 }) // keepWaiting
    const win = makeFakeWindow()
    mod.registerWindowHandlers(win as never)

    emitClose(win)
    await vi.advanceTimersByTimeAsync(3000)
    await Promise.resolve()
    await Promise.resolve()
    expect(win.close).not.toHaveBeenCalled()

    showMessageBox.mockClear()
    win.webContents.send.mockClear()
    emitClose(win)
    expect(win.webContents.send).toHaveBeenCalledWith('window:before-close')
    ack()
    await vi.advanceTimersByTimeAsync(3000)
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  it('CA-12: re-registering for a re-created window does not throw and rebinds controls', async () => {
    const first = makeFakeWindow()
    mod.registerWindowHandlers(first as never)

    const second = makeFakeWindow()
    expect(() => mod.registerWindowHandlers(second as never)).not.toThrow()

    // Window controls now act on the second (current) window.
    await ipcHandlers.get('window:minimize')!({})
    expect(second.minimize).toHaveBeenCalledTimes(1)
    expect(first.minimize).not.toHaveBeenCalled()

    // Re-close-guard now targets the second window too.
    emitClose(second)
    expect(second.webContents.send).toHaveBeenCalledWith('window:before-close')
  })

  it('CA-12: repeated registration does not accumulate before-quit listeners', () => {
    mod.registerWindowHandlers(makeFakeWindow() as never)
    const afterFirst = appListeners['before-quit']?.length ?? 0
    expect(afterFirst).toBe(1)
    mod.registerWindowHandlers(makeFakeWindow() as never)
    mod.registerWindowHandlers(makeFakeWindow() as never)
    expect(appListeners['before-quit']?.length ?? 0).toBe(afterFirst)
  })

  it('quit path (e.g. macOS Cmd+Q) routes the confirmed close through app.quit()', async () => {
    const win = makeFakeWindow()
    mod.registerWindowHandlers(win as never)

    const event = { preventDefault: vi.fn() }
    appListeners['before-quit']![0]!(event)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)

    ack()
    await ipcHandlers.get('window:close-confirmed')!({})
    expect(appQuit).toHaveBeenCalledTimes(1)
    expect(win.close).not.toHaveBeenCalled()
  })
})
