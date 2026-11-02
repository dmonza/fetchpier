/**
 * Tests for the sender-scoped window controls. The handlers must resolve the
 * BrowserWindow that owns the calling renderer and act on THAT window, and must
 * be safe no-ops when the window is gone. We stub `BrowserWindow.fromWebContents`
 * so each test controls which (fake) window the sender maps to.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: { sender: unknown }, ...args: unknown[]) => unknown

interface FakeWindow {
  minimize: ReturnType<typeof vi.fn>
  maximize: ReturnType<typeof vi.fn>
  unmaximize: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  isMaximized: ReturnType<typeof vi.fn>
}

const handlers = new Map<string, Handler>()
let resolvedWindow: FakeWindow | null = null

function makeFakeWindow(isMaximized = false): FakeWindow {
  return {
    minimize: vi.fn(),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    close: vi.fn(),
    isMaximized: vi.fn(() => isMaximized)
  }
}

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn)
    }
  },
  BrowserWindow: {
    fromWebContents: () => resolvedWindow
  }
}))

let mod: typeof import('./window-controls.ipc')
const event = { sender: {} }

beforeEach(async () => {
  handlers.clear()
  resolvedWindow = null
  vi.resetModules()
  mod = await import('./window-controls.ipc')
  mod.registerWindowControlsHandlers()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('window-controls IPC handlers', () => {
  it('registers the four sender-scoped channels', () => {
    expect(handlers.has('window:self-minimize')).toBe(true)
    expect(handlers.has('window:self-maximize-toggle')).toBe(true)
    expect(handlers.has('window:self-close')).toBe(true)
    expect(handlers.has('window:self-is-maximized')).toBe(true)
  })

  it('minimizes the sender window', async () => {
    resolvedWindow = makeFakeWindow()
    await handlers.get('window:self-minimize')!(event)
    expect(resolvedWindow.minimize).toHaveBeenCalledTimes(1)
  })

  it('maximize-toggle maximizes when not maximized', async () => {
    resolvedWindow = makeFakeWindow(false)
    await handlers.get('window:self-maximize-toggle')!(event)
    expect(resolvedWindow.maximize).toHaveBeenCalledTimes(1)
    expect(resolvedWindow.unmaximize).not.toHaveBeenCalled()
  })

  it('maximize-toggle unmaximizes when already maximized', async () => {
    resolvedWindow = makeFakeWindow(true)
    await handlers.get('window:self-maximize-toggle')!(event)
    expect(resolvedWindow.unmaximize).toHaveBeenCalledTimes(1)
    expect(resolvedWindow.maximize).not.toHaveBeenCalled()
  })

  it('closes the sender window', async () => {
    resolvedWindow = makeFakeWindow()
    await handlers.get('window:self-close')!(event)
    expect(resolvedWindow.close).toHaveBeenCalledTimes(1)
  })

  it('reports the maximized state of the sender window', async () => {
    resolvedWindow = makeFakeWindow(true)
    const result = await handlers.get('window:self-is-maximized')!(event)
    expect(result).toBe(true)
  })

  it('is a safe no-op when the sender window is gone', () => {
    resolvedWindow = null
    expect(() => handlers.get('window:self-minimize')!(event)).not.toThrow()
    expect(() => handlers.get('window:self-maximize-toggle')!(event)).not.toThrow()
    expect(() => handlers.get('window:self-close')!(event)).not.toThrow()
    expect(handlers.get('window:self-is-maximized')!(event)).toBe(false)
  })
})
