/**
 * The theme channel is what makes a preference outlive the session: it carries
 * the user's choice (which may be `system`), applies it to the platform, and
 * persists it where the window factory can read it before the next launch.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Theme } from '../../shared/types'

type Handler = (event: unknown, ...args: unknown[]) => unknown

const handlers = new Map<string, Handler>()
const syncHandlers = new Map<string, Handler>()
const written: Array<{ theme?: Theme }> = []

const nativeThemeListeners = new Map<string, () => void>()
const sentToWindow: Array<[string, unknown]> = []

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    on: (channel: string, handler: Handler) => syncHandlers.set(channel, handler)
  },
  nativeTheme: {
    themeSource: 'system' as Theme,
    shouldUseDarkColors: false,
    on: (event: string, listener: () => void) => nativeThemeListeners.set(event, listener)
  },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, payload: unknown) => sentToWindow.push([channel, payload])
        }
      }
    ]
  }
}))

vi.mock('./appsettings.ipc', () => ({
  writeAppSettings: (patch: { theme?: Theme }) => {
    written.push(patch)
    return {}
  }
}))

const updateWindowBackgrounds = vi.fn()
vi.mock('../window/window-appearance', () => ({ updateWindowBackgrounds }))

// The effective palettes (workspace over user) — what backgrounds must follow.
const EFFECTIVE = { light: { canvas: '#fafafa' }, dark: { canvas: '#050505' } }
vi.mock('./appearance.ipc', () => ({ currentAppearance: () => ({ palettes: EFFECTIVE }) }))

const { nativeTheme } = await import('electron')
const { registerThemeHandlers } = await import('./theme.ipc')

registerThemeHandlers()
const setNativeTheme = (value: unknown): unknown =>
  handlers.get('theme:setNativeTheme')!(null, value)

beforeEach(() => {
  written.length = 0
  nativeTheme.themeSource = 'system'
})

describe('theme channel surface', () => {
  it('registers no synchronous channel', () => {
    // The renderer receives the resolved theme as a process argument instead.
    // A synchronous channel would stall it whenever the main process is busy —
    // which, since deferred loading, is exactly when the renderer starts.
    expect([...syncHandlers.keys()]).toHaveLength(0)
  })
})

describe('theme:setNativeTheme', () => {
  it.each(['light', 'dark', 'system'] as const)('applies and persists %s', (theme) => {
    setNativeTheme(theme)

    expect(nativeTheme.themeSource).toBe(theme)
    expect(written).toEqual([{ theme }])
  })

  it('carries the preference rather than the resolved value', () => {
    // Persisting `light`/`dark` for a user who chose `system` would pin the
    // theme to whatever the OS happened to be at the time.
    setNativeTheme('system')
    expect(written[0].theme).toBe('system')
  })

  it.each([
    ['an unrecognised string', 'solarized'],
    ['an empty string', ''],
    ['a number', 1],
    ['undefined', undefined],
    ['an object', { theme: 'dark' }]
  ])('ignores %s without touching the platform or the settings file', (_label, value) => {
    setNativeTheme(value)

    expect(nativeTheme.themeSource).toBe('system')
    expect(written).toHaveLength(0)
  })
})

// Requirement *Dynamic color themes* §6.8: when the resolved mode changes, every
// window's background follows the canvas of the palette chosen for the new mode
// (CA-28, main side) — and the renderer is told, as before.
describe('platform theme updates', () => {
  it('notifies the windows and moves their backgrounds onto the new mode', () => {
    sentToWindow.length = 0
    updateWindowBackgrounds.mockClear()
    nativeThemeListeners.get('updated')!()

    expect(sentToWindow).toEqual([['theme:systemChanged', false]])
    expect(updateWindowBackgrounds).toHaveBeenCalledTimes(1)
    expect(updateWindowBackgrounds).toHaveBeenCalledWith(EFFECTIVE)
  })
})
