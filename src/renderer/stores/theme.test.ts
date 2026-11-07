/**
 * The renderer no longer decides the theme — the main process resolves the
 * preference before the window exists and exposes it as a platform signal. The
 * store's job is to mirror a user's pick back to main and to hold the
 * preference for the picker, never to persist it locally or to derive the
 * visible theme on its own.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyPlatformTheme, resolvePlatformTheme } from '../lib/platform-theme'
import { selectDisplayedTheme, useThemeStore } from './theme'

const setNativeTheme = vi.fn()
let initialResolved: 'light' | 'dark' = 'light'

beforeEach(() => {
  setNativeTheme.mockReset()
  initialResolved = 'light'
  document.documentElement.classList.remove('dark')
  vi.stubGlobal('window', {
    ...window,
    api: {
      theme: {
        setNativeTheme,
        onSystemChanged: vi.fn(),
        get initialResolved() {
          return initialResolved
        }
      }
    }
  })
  useThemeStore.setState({ theme: 'system', resolvedTheme: 'light' })
})

describe('platform theme', () => {
  it.each(['light', 'dark'] as const)('adopts the %s theme main already resolved', (theme) => {
    initialResolved = theme
    expect(resolvePlatformTheme()).toBe(theme)
  })

  it('marks the document so the stylesheet dark variant applies', () => {
    initialResolved = 'dark'
    expect(applyPlatformTheme()).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('clears the mark when the resolved theme is light', () => {
    document.documentElement.classList.add('dark')
    initialResolved = 'light'

    expect(applyPlatformTheme()).toBe('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })
})

describe('useThemeStore', () => {
  it.each(['light', 'dark', 'system'] as const)('mirrors the %s pick to main', (theme) => {
    useThemeStore.getState().setTheme(theme)

    expect(useThemeStore.getState().theme).toBe(theme)
    expect(setNativeTheme).toHaveBeenCalledWith(theme)
  })

  it('leaves the resolved theme to the platform signal', () => {
    // Deriving it here would give the app a second, competing opinion about
    // what is on screen — the one thing early theme resolution removes.
    useThemeStore.getState().setTheme('dark')
    expect(useThemeStore.getState().resolvedTheme).toBe('light')
  })

  it('adopts a stored preference without echoing it back to main', () => {
    useThemeStore.getState().hydrateTheme('dark')

    expect(useThemeStore.getState().theme).toBe('dark')
    expect(setNativeTheme).not.toHaveBeenCalled()
  })
})

// Requirement *Dynamic color themes* §6.6: previewing the mode that is not on
// screen changes only what is displayed — never the preference, never main.
describe('mode preview', () => {
  it('displays the previewed mode without touching the preference or main', () => {
    useThemeStore.setState({ theme: 'light', resolvedTheme: 'light', previewTheme: null })
    useThemeStore.getState().setPreviewTheme('dark')

    expect(selectDisplayedTheme(useThemeStore.getState())).toBe('dark')
    expect(useThemeStore.getState().theme).toBe('light')
    expect(useThemeStore.getState().resolvedTheme).toBe('light')
    expect(setNativeTheme).not.toHaveBeenCalled()
  })

  it('falls back to the resolved mode when the preview ends', () => {
    useThemeStore.setState({ resolvedTheme: 'light', previewTheme: 'dark' })
    useThemeStore.getState().setPreviewTheme(null)
    expect(selectDisplayedTheme(useThemeStore.getState())).toBe('light')
  })

  it('holds the preview while the platform changes mode underneath it', () => {
    useThemeStore.setState({ resolvedTheme: 'light', previewTheme: 'dark' })
    useThemeStore.getState().setResolvedTheme('dark')
    useThemeStore.getState().setResolvedTheme('light')
    expect(selectDisplayedTheme(useThemeStore.getState())).toBe('dark')
    useThemeStore.getState().setPreviewTheme(null)
    expect(selectDisplayedTheme(useThemeStore.getState())).toBe('light')
  })
})
