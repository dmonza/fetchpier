/**
 * Idempotent global registration (REQ-0104, CA-12). `registerDisplayHandlers`
 * is called again whenever a window is re-created (e.g. macOS `activate` with
 * no windows open) — the three `ipcMain.handle` channels and the `screen`
 * listener must register exactly once, and subsequent calls must rebind the
 * current window without throwing or accumulating listeners.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, ...args: unknown[]) => unknown

interface FakeWindow {
  isDestroyed: ReturnType<typeof vi.fn>
  webContents: {
    send: ReturnType<typeof vi.fn>
    setZoomFactor: ReturnType<typeof vi.fn>
    getZoomFactor: ReturnType<typeof vi.fn>
  }
}

function makeFakeWindow(zoom = 1): FakeWindow {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: {
      send: vi.fn(),
      setZoomFactor: vi.fn(),
      getZoomFactor: vi.fn(() => zoom)
    }
  }
}

const ipcHandlers = new Map<string, Handler>()
const screenListeners: Array<() => void> = []
let scaleFactor = 2

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      if (ipcHandlers.has(channel)) {
        throw new Error(`Attempted to register a second handler for '${channel}'`)
      }
      ipcHandlers.set(channel, fn)
    }
  },
  screen: {
    getPrimaryDisplay: () => ({ scaleFactor }),
    on: (_event: string, cb: () => void) => {
      screenListeners.push(cb)
    }
  }
}))

vi.mock('./appsettings.ipc', () => ({
  readAppSettings: () => ({ zoomFactor: 1 }),
  writeAppSettings: vi.fn()
}))

let mod: typeof import('./display.ipc')

beforeEach(async () => {
  ipcHandlers.clear()
  screenListeners.length = 0
  scaleFactor = 2
  vi.resetModules()
  mod = await import('./display.ipc')
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('display.ipc — idempotent registration', () => {
  it('registers the three channels and the screen listener exactly once across repeated calls', () => {
    const first = makeFakeWindow()
    mod.registerDisplayHandlers(first as never)
    expect(screenListeners).toHaveLength(1)

    const second = makeFakeWindow()
    expect(() => mod.registerDisplayHandlers(second as never)).not.toThrow()
    expect(screenListeners).toHaveLength(1)

    const third = makeFakeWindow()
    mod.registerDisplayHandlers(third as never)
    expect(screenListeners).toHaveLength(1)
  })

  it('after re-registration, handlers act on the current (latest) window', async () => {
    const first = makeFakeWindow(1)
    mod.registerDisplayHandlers(first as never)

    const second = makeFakeWindow(1.5)
    mod.registerDisplayHandlers(second as never)

    const zoom = await ipcHandlers.get('display:getZoom')!({})
    expect(zoom).toBe(1.5)
    expect(second.webContents.getZoomFactor).toHaveBeenCalled()
    expect(first.webContents.getZoomFactor).not.toHaveBeenCalled()
  })

  it('the screen listener broadcasts to the current window only', () => {
    const first = makeFakeWindow()
    mod.registerDisplayHandlers(first as never)
    const second = makeFakeWindow()
    mod.registerDisplayHandlers(second as never)

    scaleFactor = 3
    screenListeners[0]!()

    expect(second.webContents.send).toHaveBeenCalledWith('display:scaleChanged', 3)
    expect(first.webContents.send).not.toHaveBeenCalled()
  })
})
