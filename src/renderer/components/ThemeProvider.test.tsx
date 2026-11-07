/**
 * ThemeProvider is the single place that decides what this window displays:
 * the mode (the preview when there is one) and that mode's palette (the live
 * draft while editing, else what is in force). Requirement *Dynamic color
 * themes* §6.5, §6.6, §6.8.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemeProvider } from './ThemeProvider'
import { useAppearanceStore } from '../stores/appearance'
import { useThemeStore } from '../stores/theme'
import type { AppearanceState } from '../../shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const html = document.documentElement
let root: Root | null = null
let container: HTMLElement
let changed: ((s: AppearanceState) => void) | null = null
let frames: Array<() => void> = []

const LIGHT = { canvas: '#fafafa' }
const DARK = { canvas: '#050505' }
const ORIGINAL_PREFS = {
  schemaVersion: 1 as const,
  light: { selected: 'ocean' },
  dark: { selected: 'forest' }
}

beforeEach(() => {
  html.removeAttribute('style')
  html.classList.remove('dark')
  frames = []
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => frames.push(cb))
  vi.stubGlobal('window', {
    ...window,
    requestAnimationFrame: (cb: () => void) => frames.push(cb),
    api: {
      theme: {
        initialResolved: 'light',
        onSystemChanged: vi.fn(() => () => undefined),
        setNativeTheme: vi.fn()
      },
      appSettings: { get: vi.fn(() => Promise.resolve({ theme: 'light' })) },
      appearance: {
        initial: { light: LIGHT, dark: DARK },
        get: vi.fn(() =>
          Promise.resolve({
            prefs: ORIGINAL_PREFS,
            workspace: null,
            palettes: { light: LIGHT, dark: DARK }
          })
        ),
        set: vi.fn(),
        onChanged: vi.fn((cb: (s: AppearanceState) => void) => {
          changed = cb
          return () => undefined
        })
      }
    }
  })
  useAppearanceStore.getState().reset()
  useThemeStore.setState({ theme: 'light', resolvedTheme: 'light', previewTheme: null })
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container.remove()
  vi.unstubAllGlobals()
})

async function mount(): Promise<void> {
  await act(async () => {
    root = createRoot(container)
    root.render(<ThemeProvider>{null}</ThemeProvider>)
  })
}

const canvas = (): string => html.style.getPropertyValue('--canvas')

describe('ThemeProvider', () => {
  it('applies the palette of the mode on screen', async () => {
    await mount()
    expect(html.classList.contains('dark')).toBe(false)
    expect(canvas()).toBe('#fafafa')
  })

  it('switches mode and palette together, in the same frame, for a preview (CA-22)', async () => {
    await mount()
    act(() => useThemeStore.getState().setPreviewTheme('dark'))
    expect(html.classList.contains('dark')).toBe(true)
    expect(canvas()).toBe('#050505')
    act(() => useThemeStore.getState().setPreviewTheme(null))
    expect(html.classList.contains('dark')).toBe(false)
    expect(canvas()).toBe('#fafafa')
  })

  it('applies a live draft at the next frame', async () => {
    await mount()
    act(() => useAppearanceStore.getState().preview('light', { canvas: '#eeeeee' }))
    expect(canvas()).toBe('#fafafa')
    act(() => frames.splice(0).forEach((f) => f()))
    expect(canvas()).toBe('#eeeeee')
  })

  it('removes every override when Original is in force', async () => {
    await mount()
    act(() =>
      changed!({ prefs: ORIGINAL_PREFS, workspace: null, palettes: { light: null, dark: DARK } })
    )
    act(() => frames.splice(0).forEach((f) => f()))
    expect(canvas()).toBe('')
  })

  it('follows the platform when the mode in force changes (CA-28, renderer side)', async () => {
    await mount()
    act(() => useThemeStore.getState().setResolvedTheme('dark'))
    expect(html.classList.contains('dark')).toBe(true)
    expect(canvas()).toBe('#050505')
  })

  // Requirement *Workspace color palettes* §6.3: a palette shown in place of the
  // effective one for a mode — below a live draft, above what is in force.
  it('shows a display override for its mode, under a draft', async () => {
    await mount()
    act(() =>
      useAppearanceStore
        .getState()
        .setDisplayOverride({ mode: 'light', tokens: { canvas: '#dddddd' } })
    )
    act(() => frames.splice(0).forEach((f) => f()))
    expect(canvas()).toBe('#dddddd')

    act(() => useAppearanceStore.getState().preview('light', { canvas: '#cccccc' }))
    act(() => frames.splice(0).forEach((f) => f()))
    expect(canvas()).toBe('#cccccc')

    act(() => useAppearanceStore.getState().setDisplayOverride(null))
    act(() => useAppearanceStore.getState().reset())
    act(() => frames.splice(0).forEach((f) => f()))
    expect(canvas()).toBe('#fafafa')
  })

  it('ignores a display override for the other mode', async () => {
    await mount()
    act(() =>
      useAppearanceStore
        .getState()
        .setDisplayOverride({ mode: 'dark', tokens: { canvas: '#111111' } })
    )
    act(() => frames.splice(0).forEach((f) => f()))
    expect(canvas()).toBe('#fafafa')
  })
})
