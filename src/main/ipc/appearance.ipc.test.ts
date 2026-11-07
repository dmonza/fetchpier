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

const { registerAppearanceHandlers } = await import('./appearance.ipc')
registerAppearanceHandlers()
const get = (): AppearanceState => handlers.get('appearance:get')!(null) as AppearanceState
const set = (payload: unknown): AppearanceState =>
  handlers.get('appearance:set')!(null, payload) as AppearanceState

const custom = { hue: 150, intensity: 70, surfaceTint: 40, brightness: 70 }

beforeEach(() => {
  windows = [fakeWindow(), fakeWindow()]
  stored = { zoomFactor: 1.25 }
  failWrite = false
  nativeThemeMock.shouldUseDarkColors = false
})

describe('appearance:get', () => {
  it('reads Original in both modes when nothing is stored', () => {
    expect(get()).toEqual({
      prefs: { schemaVersion: 1, light: { selected: 'original' }, dark: { selected: 'original' } },
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
