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
