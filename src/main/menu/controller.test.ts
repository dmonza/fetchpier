/**
 * The menu controller — the piece that holds the state, decides when a rebuild
 * is warranted, and keeps the menu off the platforms that never draw it.
 *
 * Each test imports a fresh module instance (`vi.resetModules()`), so the
 * module-level state does not leak between cases and the controller needs no
 * test-only reset hatch.
 *
 * REQ Application menu coherence on macOS §6.2, §6.4, §6.6, §6.9.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { FALLBACK_MENU_LABELS } from './labels'

const setApplicationMenu = vi.fn((_menu: unknown) => undefined)
const buildFromTemplate = vi.fn((_template: unknown) => ({ __menu: true }))
const ipcHandlers = new Map<string, (...args: unknown[]) => void>()

vi.mock('electron', () => ({
  Menu: {
    setApplicationMenu: (menu: unknown) => setApplicationMenu(menu),
    buildFromTemplate: (template: unknown) => buildFromTemplate(template)
  },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null) },
  ipcMain: {
    on: (channel: string, handler: (...args: unknown[]) => void) => {
      ipcHandlers.set(channel, handler)
    }
  },
  app: { name: 'Fetchpier' }
}))

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

const realPlatform = process.platform

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

type Controller = typeof import('./controller')

async function loadController(platform: NodeJS.Platform = 'darwin'): Promise<Controller> {
  setPlatform(platform)
  vi.resetModules()
  return import('./controller')
}

/** A window stand-in with just the surface the controller touches. */
function fakeWindow(): {
  webContents: { send: ReturnType<typeof vi.fn> }
  isDestroyed: () => boolean
} {
  return { webContents: { send: vi.fn() }, isDestroyed: () => false }
}

beforeEach(() => {
  setApplicationMenu.mockClear()
  buildFromTemplate.mockClear()
  ipcHandlers.clear()
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
})

describe('platform gating', () => {
  // CA-15 — the menu is only installed where it is drawn.
  it('installs no application menu off macOS', async () => {
    const c = await loadController('win32')
    c.rebuildMenu()

    expect(setApplicationMenu).toHaveBeenCalledWith(null)
    expect(buildFromTemplate).not.toHaveBeenCalled()
  })

  it('installs no application menu on linux either', async () => {
    const c = await loadController('linux')
    c.rebuildMenu()

    expect(setApplicationMenu).toHaveBeenCalledWith(null)
    expect(buildFromTemplate).not.toHaveBeenCalled()
  })

  it('builds and installs the menu on macOS', async () => {
    const c = await loadController('darwin')
    c.rebuildMenu()

    expect(buildFromTemplate).toHaveBeenCalledTimes(1)
    expect(setApplicationMenu).toHaveBeenCalledWith({ __menu: true })
  })
})

describe('rebuild policy', () => {
  // CA-02 — the menu follows the state without the user touching it, and a
  // patch that changes nothing costs nothing.
  it('rebuilds when a governing condition actually changes', async () => {
    const c = await loadController('darwin')
    c.patchMenuState({ hasWorkspace: true })
    const before = buildFromTemplate.mock.calls.length

    c.patchMenuState({ hasWorkspace: false })

    expect(buildFromTemplate.mock.calls.length).toBe(before + 1)
  })

  it('does not rebuild when the patch leaves the state unchanged', async () => {
    const c = await loadController('darwin')
    c.patchMenuState({ hasWorkspace: true })
    const before = buildFromTemplate.mock.calls.length

    c.patchMenuState({ hasWorkspace: true })
    c.patchMenuState({})

    expect(buildFromTemplate.mock.calls.length).toBe(before)
  })

  it('tracks whether a window exists as the window comes and goes', async () => {
    const c = await loadController('darwin')

    c.setMenuWindow(fakeWindow() as never)
    expect(c.getMenuState().hasWindow).toBe(true)

    c.setMenuWindow(null)
    expect(c.getMenuState().hasWindow).toBe(false)
  })
})

describe('vocabulary and readiness', () => {
  // CA-05 / CA-12 — the labels arriving is what ends the starting state.
  it('starts not ready and becomes ready when the vocabulary arrives', async () => {
    const c = await loadController('darwin')
    expect(c.getMenuState().rendererReady).toBe(false)

    c.applyMenuLabels(FALLBACK_MENU_LABELS)

    expect(c.getMenuState().rendererReady).toBe(true)
  })

  it('rebuilds on every vocabulary push, so a language change is reflected', async () => {
    const c = await loadController('darwin')
    c.applyMenuLabels(FALLBACK_MENU_LABELS)
    const before = buildFromTemplate.mock.calls.length

    c.applyMenuLabels({
      ...FALLBACK_MENU_LABELS,
      file: { ...FALLBACK_MENU_LABELS.file, label: 'Archivo' }
    })

    expect(buildFromTemplate.mock.calls.length).toBe(before + 1)
  })

  it('discards a malformed vocabulary rather than half-applying it', async () => {
    const c = await loadController('darwin')

    c.applyMenuLabels({ file: { label: 'Archivo' } } as never)

    expect(c.getMenuState().rendererReady).toBe(false)
  })
})

describe('action dispatch', () => {
  it('delivers an action to the main window', async () => {
    const c = await loadController('darwin')
    const win = fakeWindow()
    c.setMenuWindow(win as never)

    c.sendMenuAction('file.newRequest')

    expect(win.webContents.send).toHaveBeenCalledWith('menu:action', 'file.newRequest')
  })

  // CA-06 — with no window, the two revival items create one instead of
  // addressing a window that does not exist.
  it('creates a window before dispatching when none exists', async () => {
    const c = await loadController('darwin')
    const win = fakeWindow()
    const factory = vi.fn(() => {
      c.setMenuWindow(win as never)
    })
    c.setMenuWindowFactory(factory)
    c.setMenuWindow(null)

    c.sendMenuAction('file.newRequest')

    expect(factory).toHaveBeenCalledTimes(1)
    expect(win.webContents.send).toHaveBeenCalledWith('menu:action', 'file.newRequest')
  })

  it('never addresses a destroyed window', async () => {
    const c = await loadController('darwin')
    const win = { webContents: { send: vi.fn() }, isDestroyed: () => true }
    c.setMenuWindow(win as never)

    expect(() => c.sendMenuAction('file.save')).not.toThrow()
    expect(win.webContents.send).not.toHaveBeenCalled()
  })
})

describe('ipc registration', () => {
  it('registers its listeners once, however many times it is called', async () => {
    const c = await loadController('darwin')
    c.registerMenuIpc()
    const channels = [...ipcHandlers.keys()].sort()

    ipcHandlers.clear()
    c.registerMenuIpc()

    expect(channels).toEqual(['menu:setLabels', 'menu:setState'])
    expect([...ipcHandlers.keys()]).toEqual([])
  })

  it('applies a tab-state push from the interface', async () => {
    const c = await loadController('darwin')
    c.registerMenuIpc()

    ipcHandlers.get('menu:setState')?.({}, { hasAnyTab: true, hasActiveTab: true })

    expect(c.getMenuState().hasAnyTab).toBe(true)
    expect(c.getMenuState().hasActiveTab).toBe(true)
  })

  it('ignores a malformed state push', async () => {
    const c = await loadController('darwin')
    c.registerMenuIpc()

    ipcHandlers.get('menu:setState')?.({}, { hasAnyTab: 'yes' })

    expect(c.getMenuState().hasAnyTab).toBe(false)
  })
})
