/**
 * Early theme resolution at window creation.
 *
 * The ordering asserted here is the whole mechanism behind a startup that does
 * not flash: the platform theme has to be set *before* the `BrowserWindow`
 * exists, because that is what decides the colour it is constructed with, the
 * theme applied to native decorations, and the `prefers-color-scheme` the
 * startup shell reads. Setting it afterwards would still be correct in the end
 * and still look wrong for the first half second.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WINDOW_BACKGROUND } from '../../shared/app-shell'
import { generatePalette } from '../../shared/palette/generate'
import { decodePaletteArg } from '../../shared/palette/launch-arg'
import { findPreset } from '../../shared/palette/presets'
import type { AppSettings, Theme } from '../../shared/types'

/** Ordered log of what the factory did, so "before" can be asserted at all. */
const calls: string[] = []
let settings: Partial<AppSettings> = {}
let systemIsDark = false
let constructorOptions: Record<string, unknown> = {}

const nativeThemeMock = {
  _themeSource: 'system' as Theme,
  get themeSource(): Theme {
    return this._themeSource
  },
  set themeSource(value: Theme) {
    this._themeSource = value
    calls.push(`themeSource=${value}`)
  },
  get shouldUseDarkColors(): boolean {
    if (this._themeSource === 'dark') return true
    if (this._themeSource === 'light') return false
    return systemIsDark
  }
}

vi.mock('electron', () => ({
  BrowserWindow: class {
    constructor(options: Record<string, unknown>) {
      constructorOptions = options
      calls.push('new BrowserWindow')
    }
    on = vi.fn()
    once = vi.fn()
    maximize = vi.fn()
    isMaximized = (): boolean => false
    getBounds = (): object => ({ x: 0, y: 0, width: 1200, height: 800 })
    getNormalBounds = (): object => ({ x: 0, y: 0, width: 1200, height: 800 })
    webContents = { on: vi.fn(), send: vi.fn() }
  },
  nativeTheme: nativeThemeMock,
  screen: { getAllDisplays: () => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }] }
}))

vi.mock('../ipc/appsettings.ipc', () => ({
  readAppSettings: () => {
    calls.push('readAppSettings')
    return settings
  },
  writeAppSettings: vi.fn()
}))

const { createMainWindow } = await import('./create-main-window')

beforeEach(() => {
  calls.length = 0
  constructorOptions = {}
  settings = {}
  systemIsDark = false
  nativeThemeMock._themeSource = 'system'
})

describe('createMainWindow — theme resolution', () => {
  it('applies the persisted preference before the window is constructed', () => {
    settings = { theme: 'dark' }
    createMainWindow()

    expect(calls).toContain('themeSource=dark')
    expect(calls.indexOf('themeSource=dark')).toBeLessThan(calls.indexOf('new BrowserWindow'))
  })

  it.each([
    ['dark', false, WINDOW_BACKGROUND.dark],
    ['light', true, WINDOW_BACKGROUND.light]
  ] as const)(
    'constructs a %s window even when the operating system disagrees',
    (theme, osIsDark, expected) => {
      systemIsDark = osIsDark
      settings = { theme }
      createMainWindow()

      expect(nativeThemeMock.themeSource).toBe(theme)
      expect(constructorOptions.backgroundColor).toBe(expected)
    }
  )

  it.each([
    ['a dark operating system', true, WINDOW_BACKGROUND.dark],
    ['a light operating system', false, WINDOW_BACKGROUND.light]
  ])('follows %s when the preference is system', (_label, osIsDark, expected) => {
    systemIsDark = osIsDark
    settings = { theme: 'system' }
    createMainWindow()

    expect(nativeThemeMock.themeSource).toBe('system')
    expect(constructorOptions.backgroundColor).toBe(expected)
  })

  it('falls back to following the system when settings carry no preference', () => {
    systemIsDark = true
    settings = {}
    createMainWindow()

    expect(nativeThemeMock.themeSource).toBe('system')
    expect(constructorOptions.backgroundColor).toBe(WINDOW_BACKGROUND.dark)
  })
})

// Requirement *Dynamic color themes* §6.8: the stored palette is in force from
// the first frame — the window is constructed in its canvas colour, and the
// renderer receives both modes' overrides at launch (CA-01, CA-27).
describe('createMainWindow — palette', () => {
  const launchArgs = (): string[] =>
    ((constructorOptions.webPreferences as { additionalArguments?: string[] })
      ?.additionalArguments ?? []) as string[]

  it('keeps the Original canvas and hands no overrides when no palette is stored', () => {
    settings = { theme: 'dark' }
    createMainWindow()

    expect(constructorOptions.backgroundColor).toBe(WINDOW_BACKGROUND.dark)
    expect(decodePaletteArg(launchArgs())).toEqual({ light: null, dark: null })
  })

  it('constructs the window in the stored palette of the resolved mode', () => {
    const custom = { hue: 150, intensity: 70, surfaceTint: 40, brightness: 70 }
    settings = {
      theme: 'dark',
      appearancePalettes: {
        schemaVersion: 1,
        light: { selected: 'ocean' },
        dark: { selected: 'custom', custom }
      }
    }
    createMainWindow()

    const dark = generatePalette('dark', custom)
    expect(constructorOptions.backgroundColor).toBe(dark.canvas)
    expect(dark.canvas).not.toBe(WINDOW_BACKGROUND.dark)
    const handed = decodePaletteArg(launchArgs())
    expect(handed.dark).toEqual(dark)
    expect(handed.light).toEqual(generatePalette('light', findPreset('light', 'ocean')!.params))
  })

  it('still starts when the stored palette block is malformed', () => {
    settings = { theme: 'light', appearancePalettes: 'ocean' }
    createMainWindow()

    expect(constructorOptions.backgroundColor).toBe(WINDOW_BACKGROUND.light)
    expect(decodePaletteArg(launchArgs())).toEqual({ light: null, dark: null })
  })
})
