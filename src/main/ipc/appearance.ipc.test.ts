/**
 * The appearance channel (requirement *Dynamic color themes* §5.5): reads the
 * normalized preferences with the palettes they stand for, validates and
 * persists a change, tells every window about it, and keeps every window's
 * background colour on the canvas in force.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WINDOW_BACKGROUND } from '../../shared/app-shell'
import { generatePalette } from '../../shared/palette/generate'
import { findPreset } from '../../shared/palette/presets'
import type { AppearanceState } from '../../shared/types'

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()

interface FakeWindow {
  destroyed: boolean
  sent: Array<[string, unknown]>
  background: string | null
  isDestroyed: () => boolean
  setBackgroundColor: (c: string) => void
  webContents: { send: (channel: string, payload: unknown) => void }
}

function fakeWindow(destroyed = false): FakeWindow {
  const w: FakeWindow = {
    destroyed,
    sent: [],
    background: null,
    isDestroyed: () => w.destroyed,
    setBackgroundColor: (c) => {
      w.background = c
    },
    webContents: { send: (channel, payload) => w.sent.push([channel, payload]) }
  }
  return w
}

let windows: FakeWindow[] = []
let stored: Record<string, unknown> = {}
let failWrite = false
const nativeThemeMock = { shouldUseDarkColors: false }

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) },
  BrowserWindow: { getAllWindows: () => windows },
  nativeTheme: nativeThemeMock
}))

vi.mock('./appsettings.ipc', () => ({
  readAppSettings: () => stored,
  writeAppSettingsStrict: (patch: Record<string, unknown>) => {
    if (failWrite) throw new Error('EACCES: permission denied')
    stored = { ...stored, ...patch }
    return stored
  }
}))

// The workspace's personal state, as the store exposes it.
const wsStore = {
  active: false,
  raw: undefined as unknown,
  failWrite: false
}
vi.mock('../state/workspace-state-store', () => ({
  hasActiveWorkspace: () => wsStore.active,
  getWorkspaceAppearanceRaw: () => (wsStore.active ? wsStore.raw : undefined),
  setWorkspaceAppearance: async (block: unknown) => {
    if (!wsStore.active) throw new Error('No workspace is open')
    if (wsStore.failWrite) throw new Error('EACCES: permission denied')
    wsStore.raw = block
  }
}))

const { registerAppearanceHandlers, broadcastAppearance } = await import('./appearance.ipc')
const { setStartupWorkspaceHint, clearStartupWorkspaceHint } =
  await import('../window/window-appearance')
registerAppearanceHandlers()
const get = (): AppearanceState => handlers.get('appearance:get')!(null) as AppearanceState
const set = (payload: unknown): AppearanceState =>
  handlers.get('appearance:set')!(null, payload) as AppearanceState
const setWorkspace = (payload: unknown): Promise<AppearanceState> =>
  handlers.get('appearance:setWorkspace')!(null, payload) as Promise<AppearanceState>

const custom = { hue: 150, intensity: 70, surfaceTint: 40, brightness: 70 }

beforeEach(() => {
  windows = [fakeWindow(), fakeWindow()]
  stored = { zoomFactor: 1.25 }
  failWrite = false
  nativeThemeMock.shouldUseDarkColors = false
  wsStore.active = false
  wsStore.raw = undefined
  wsStore.failWrite = false
  clearStartupWorkspaceHint()
})

describe('appearance:get', () => {
  it('reads Original in both modes when nothing is stored', () => {
    expect(get()).toEqual({
      prefs: { schemaVersion: 1, light: { selected: 'original' }, dark: { selected: 'original' } },
      workspace: null,
      palettes: { light: null, dark: null }
    })
  })

  it('normalizes what is stored and resolves the palettes', () => {
    stored = {
      appearancePalettes: {
        schemaVersion: 1,
        light: { selected: 'sunset' },
        dark: { selected: 'custom', custom }
      }
    }
    const state = get()
    expect(state.prefs.light).toEqual({ selected: 'original' })
    expect(state.palettes.light).toBeNull()
    expect(state.palettes.dark).toEqual(generatePalette('dark', custom))
  })
})

describe('appearance:set', () => {
  it('persists the normalized preferences and returns the resolved state', () => {
    const state = set({
      schemaVersion: 1,
      light: { selected: 'ocean' },
      dark: { selected: 'custom', custom: { ...custom, hue: 999 } }
    })
    expect(state.prefs.dark.custom!.hue).toBe(360)
    expect(stored.appearancePalettes).toEqual(state.prefs)
    expect(stored.zoomFactor).toBe(1.25)
    expect(state.palettes.light).toEqual(
      generatePalette('light', findPreset('light', 'ocean')!.params)
    )
  })

  it('tells every open window, skipping destroyed ones', () => {
    windows.push(fakeWindow(true))
    const state = set({
      schemaVersion: 1,
      light: { selected: 'forest' },
      dark: { selected: 'original' }
    })
    expect(windows[0].sent).toEqual([['appearance:changed', state]])
    expect(windows[1].sent).toEqual([['appearance:changed', state]])
    expect(windows[2].sent).toEqual([])
  })

  it('moves every window background onto the canvas in force', () => {
    nativeThemeMock.shouldUseDarkColors = true
    set({ schemaVersion: 1, light: { selected: 'original' }, dark: { selected: 'custom', custom } })
    expect(windows[0].background).toBe(generatePalette('dark', custom).canvas)

    nativeThemeMock.shouldUseDarkColors = false
    set({ schemaVersion: 1, light: { selected: 'original' }, dark: { selected: 'custom', custom } })
    expect(windows[0].background).toBe(WINDOW_BACKGROUND.light)
  })

  it.each([
    ['null', null],
    ['a string', 'ocean'],
    ['an array', []],
    ['a number', 3]
  ])('rejects %s without writing or telling anyone', (_label, payload) => {
    expect(() => set(payload)).toThrow(/appearance/i)
    expect(stored.appearancePalettes).toBeUndefined()
    expect(windows[0].sent).toEqual([])
  })

  it('reports a failed write and changes nothing (CA-33)', () => {
    failWrite = true
    expect(() =>
      set({ schemaVersion: 1, light: { selected: 'forest' }, dark: { selected: 'original' } })
    ).toThrow(/permission denied/)
    expect(stored.appearancePalettes).toBeUndefined()
    expect(windows[0].sent).toEqual([])
    expect(windows[0].background).toBeNull()
  })
})

// Requirement *Workspace color palettes* §5.5, §6.1, §6.5.
describe('the workspace level', () => {
  const forestDark = {
    schemaVersion: 1,
    light: { selected: 'inherit' },
    dark: { selected: 'forest' }
  }

  it('reports the workspace and the effective palettes (CA-02)', () => {
    stored = {
      appearancePalettes: {
        schemaVersion: 1,
        light: { selected: 'ocean' },
        dark: { selected: 'original' }
      }
    }
    wsStore.active = true
    wsStore.raw = forestDark
    const state = get()
    expect(state.workspace).toEqual(forestDark)
    expect(state.palettes.light).toEqual(
      generatePalette('light', findPreset('light', 'ocean')!.params)
    )
    expect(state.palettes.dark).toEqual(
      generatePalette('dark', findPreset('dark', 'forest')!.params)
    )
  })

  it('reads a workspace without a block as inheriting both modes (CA-01)', () => {
    wsStore.active = true
    expect(get().workspace).toEqual({
      schemaVersion: 1,
      light: { selected: 'inherit' },
      dark: { selected: 'inherit' }
    })
  })

  it('keeps an overridden mode when the user changes theirs (CA-11)', () => {
    wsStore.active = true
    wsStore.raw = forestDark
    const state = set({
      schemaVersion: 1,
      light: { selected: 'paper' },
      dark: { selected: 'graphite' }
    })
    expect(state.palettes.light).toEqual(
      generatePalette('light', findPreset('light', 'paper')!.params)
    )
    expect(state.palettes.dark).toEqual(
      generatePalette('dark', findPreset('dark', 'forest')!.params)
    )
  })

  it('persists, tells every window and moves backgrounds on a workspace write', async () => {
    wsStore.active = true
    nativeThemeMock.shouldUseDarkColors = true
    const state = await setWorkspace({
      ...forestDark,
      dark: { selected: 'forest', custom: { ...custom, hue: 999 } }
    })
    expect(wsStore.raw).toEqual(state.workspace)
    expect(state.workspace!.dark.custom!.hue).toBe(360)
    expect(stored.appearancePalettes).toBeUndefined()
    expect(windows[0].sent).toEqual([['appearance:changed', state]])
    expect(windows[0].background).toBe(state.palettes.dark!.canvas)
  })

  it.each([
    ['null', null],
    ['a string', 'forest'],
    ['an array', []]
  ])('rejects %s without writing', async (_label, payload) => {
    wsStore.active = true
    await expect(setWorkspace(payload)).rejects.toThrow(/appearance/i)
    expect(wsStore.raw).toBeUndefined()
    expect(windows[0].sent).toEqual([])
  })

  it('rejects a workspace write with no workspace open (CA-06)', async () => {
    await expect(setWorkspace(forestDark)).rejects.toThrow(/workspace/i)
    expect(windows[0].sent).toEqual([])
  })

  it('reports a failed workspace write and tells no one (CA-07)', async () => {
    wsStore.active = true
    wsStore.failWrite = true
    await expect(setWorkspace(forestDark)).rejects.toThrow(/permission denied/)
    expect(windows[0].sent).toEqual([])
  })

  it('answers with the workspace about to be restored until the restore settles', () => {
    setStartupWorkspaceHint(forestDark)
    expect(get().workspace).toEqual(forestDark)
    clearStartupWorkspaceHint()
    expect(get().workspace).toBeNull()
  })

  it('broadcasts the current state on demand (workspace opened, switched or closed)', () => {
    wsStore.active = true
    wsStore.raw = forestDark
    nativeThemeMock.shouldUseDarkColors = true
    broadcastAppearance()
    const state = get()
    expect(windows[1].sent).toEqual([['appearance:changed', state]])
    expect(windows[1].background).toBe(state.palettes.dark!.canvas)
  })
})
