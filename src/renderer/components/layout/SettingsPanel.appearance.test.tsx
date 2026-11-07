/**
 * Settings → Appearance inside the real dialog (requirement *Dynamic color
 * themes* §6.1, §6.5–§6.7): the session snapshot, the see-through backdrop and
 * outside-click rule of the Appearance tab only, the preview's end, and Escape
 * during a drag. The other tabs' content is not under test here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

vi.mock('react-i18next', () => ({
  useTranslation: (): { t: (k: string) => string } => ({ t: (key: string) => key })
}))
vi.mock('../settings/CertificatesPanel', () => ({ CertificatesPanel: () => null }))
vi.mock('../settings/WorkspaceKeysPanel', () => ({ WorkspaceKeysPanel: () => null }))

import { SettingsPanel } from './SettingsPanel'
import { OPEN_SETTINGS_EVENT } from '../../lib/events'
import { useAppearanceStore } from '../../stores/appearance'
import { useThemeStore } from '../../stores/theme'
import type { AppearancePalettes } from '../../../shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const prefs: AppearancePalettes = {
  schemaVersion: 1,
  light: { selected: 'ocean' },
  dark: { selected: 'original' }
}
let container: HTMLDivElement
let root: Root
let set: ReturnType<typeof vi.fn>

beforeEach(() => {
  set = vi.fn(async (p: AppearancePalettes) => ({
    prefs: p,
    palettes: { light: null, dark: null }
  }))
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  )
  ;(window as unknown as { api: unknown }).api = {
    appSettings: {
      get: vi.fn(async () => ({ requestTimeoutSeconds: 30 })),
      set: vi.fn(async () => ({})),
      getUpdates: vi.fn(async () => ({
        autoCheckEnabled: true,
        intervalDays: 7,
        lastCheckAt: null
      })),
      setUpdates: vi.fn()
    },
    appearance: {
      initial: { light: null, dark: null },
      get: vi.fn(async () => ({ prefs, palettes: { light: null, dark: null } })),
      set,
      onChanged: vi.fn(() => () => undefined)
    },
    theme: {
      setNativeTheme: vi.fn(),
      onSystemChanged: vi.fn(() => () => undefined),
      initialResolved: 'light'
    }
  }
  useAppearanceStore.getState().reset()
  useAppearanceStore.setState({ prefs })
  useThemeStore.setState({ theme: 'light', resolvedTheme: 'light', previewTheme: null })
  document.documentElement.removeAttribute('style')
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }
}

async function open(): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(<SettingsPanel />)
  })
  await act(async () => {
    window.dispatchEvent(new Event(OPEN_SETTINGS_EVENT))
  })
  await settle()
}

const dialog = (): HTMLElement | null => document.querySelector('[role="dialog"]')
const overlay = (): HTMLElement | null => document.querySelector('[data-slot="dialog-overlay"]')
const tab = (name: string): HTMLButtonElement => {
  const el = [...document.querySelectorAll('button')].find((b) => b.textContent === name)
  if (!el) throw new Error(`no tab ${name}`)
  return el
}
async function selectTab(name: string): Promise<void> {
  await act(async () => tab(name).click())
  await settle()
}
// Real input events are cancelable; the product relies on that to keep the
// dialog open (Escape during a drag) or to ignore an outside click.
/** A full click on the backdrop: the dialog decides "outside" from the whole sequence. */
async function pointerDownOutside(): Promise<void> {
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    await act(async () => {
      const target = overlay() ?? document.body
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }))
    })
  }
  await settle()
}
async function escape(): Promise<void> {
  await act(async () => {
    ;(document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    )
  })
  await settle()
}

describe('Settings → Appearance', () => {
  it('offers the Appearance tab and opens without changing anything on screen (CA-03, CA-21)', async () => {
    document.documentElement.style.setProperty('--canvas', '#121212')
    await open()
    expect(tab('settings.tabs.appearance')).toBeTruthy()
    expect(useAppearanceStore.getState().snapshot).toEqual({ prefs, theme: 'light' })
    await selectTab('settings.tabs.appearance')
    expect(document.documentElement.style.getPropertyValue('--canvas')).toBe('#121212')
    expect(useThemeStore.getState().previewTheme).toBeNull()
    expect(set).not.toHaveBeenCalled()
  })

  it('makes the backdrop see-through and ignores outside clicks on Appearance only (CA-23)', async () => {
    await open()
    expect(overlay()?.className).toContain('bg-black/60')
    await selectTab('settings.tabs.appearance')
    expect(overlay()?.className).toContain('bg-transparent')
    expect(overlay()?.className).not.toContain('bg-black/60')
    await pointerDownOutside()
    expect(dialog()).not.toBeNull()

    await selectTab('settings.tabs.general')
    expect(overlay()?.className).toContain('bg-black/60')
    await pointerDownOutside()
    expect(dialog()).toBeNull()
  })

  it('ends a preview when another tab is chosen or Settings closes (CA-22)', async () => {
    await open()
    await selectTab('settings.tabs.appearance')
    await act(async () => tab('settings.appearance.mode.dark').click())
    expect(useThemeStore.getState().previewTheme).toBe('dark')
    await selectTab('settings.tabs.general')
    expect(useThemeStore.getState().previewTheme).toBeNull()

    await selectTab('settings.tabs.appearance')
    await act(async () => tab('settings.appearance.mode.dark').click())
    expect(useThemeStore.getState().previewTheme).toBe('dark')
    await escape()
    expect(dialog()).toBeNull()
    expect(useThemeStore.getState().previewTheme).toBeNull()
    expect(useAppearanceStore.getState().snapshot).toBeNull()
  })

  it('cancels a drag on Escape without closing, then closes on the next Escape (CA-20)', async () => {
    await open()
    await selectTab('settings.tabs.appearance')
    act(() => {
      useAppearanceStore.getState().beginDrag('light')
      useAppearanceStore.getState().preview('light', { canvas: '#010203' })
    })
    await escape()
    expect(dialog()).not.toBeNull()
    expect(useAppearanceStore.getState().dragging).toBeNull()
    expect(useAppearanceStore.getState().drafts.light).toBeUndefined()
    await escape()
    expect(dialog()).toBeNull()
    expect(set).not.toHaveBeenCalled()
  })
})
