/**
 * Settings → Appearance (requirement *Dynamic color themes* §6.1–§6.3, §6.5,
 * §6.11, §6.12). Rendered with the real stores and a stubbed bridge; the i18n
 * layer returns keys, so the assertions name the strings by key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { AppearancePalettes, AppearanceState } from '../../../shared/types'

vi.mock('react-i18next', () => ({
  useTranslation: (): { t: (k: string) => string } => ({ t: (key: string) => key })
}))

import { AppearancePanel } from './AppearancePanel'
import { COMMIT_DELAY_MS, useAppearanceStore } from '../../stores/appearance'
import { useThemeStore } from '../../stores/theme'
import { findPreset } from '../../../shared/palette/presets'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const custom = { hue: 30, intensity: 40, surfaceTint: 20, brightness: 60 }
let stored: AppearancePalettes
let set: ReturnType<typeof vi.fn>
let setNativeTheme: ReturnType<typeof vi.fn>
let forcedColors = false
let container: HTMLDivElement
let root: Root | null = null

const state = (prefs: AppearancePalettes): AppearanceState => ({
  prefs,
  palettes: {
    light: prefs.light.selected === 'original' ? null : { canvas: '#fafafa' },
    dark: null
  }
})

beforeEach(() => {
  vi.useFakeTimers()
  forcedColors = false
  stored = {
    schemaVersion: 1,
    light: { selected: 'ocean', custom },
    dark: { selected: 'original' }
  }
  set = vi.fn(async (prefs: AppearancePalettes) => state(prefs))
  setNativeTheme = vi.fn(async () => undefined)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  )
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('forced-colors') ? forcedColors : false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  }))
  ;(window as unknown as { api: unknown }).api = {
    appearance: {
      initial: { light: null, dark: null },
      get: vi.fn(async () => state(stored)),
      set,
      onChanged: vi.fn(() => () => undefined)
    },
    theme: {
      setNativeTheme,
      onSystemChanged: vi.fn(() => () => undefined),
      initialResolved: 'light'
    }
  }
  useAppearanceStore.getState().reset()
  useAppearanceStore.setState({ prefs: stored, palettes: state(stored).palettes })
  useThemeStore.setState({ theme: 'light', resolvedTheme: 'light', previewTheme: null })
  useAppearanceStore.getState().beginSession('light')
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function mount(): Promise<void> {
  await act(async () => {
    root = createRoot(container)
    root.render(<AppearancePanel />)
  })
}

const byRole = (role: string, name: string): HTMLElement => {
  const el = [...container.querySelectorAll<HTMLElement>(`[role="${role}"]`)].find(
    (e) => e.getAttribute('aria-label') === name || e.textContent?.includes(name)
  )
  if (!el) throw new Error(`no ${role} named ${name}`)
  return el
}
const button = (name: string): HTMLButtonElement => {
  const el = [...container.querySelectorAll('button')].find(
    (b) => b.textContent?.includes(name) || b.getAttribute('aria-label') === name
  )
  if (!el) throw new Error(`no button ${name}`)
  return el
}
const click = async (el: HTMLElement): Promise<void> => {
  await act(async () => {
    el.click()
  })
}
const key = async (el: HTMLElement, k: string): Promise<void> => {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
  })
}

describe('appearance mode (CA-04)', () => {
  it('applies a mode at once and moves the palette sub-tab to it', async () => {
    await mount()
    await click(byRole('radio', 'settings.appearance.mode.dark'))
    expect(setNativeTheme).toHaveBeenCalledWith('dark')
    expect(useThemeStore.getState().theme).toBe('dark')
    expect(byRole('tab', 'settings.appearance.mode.dark').getAttribute('aria-selected')).toBe(
      'true'
    )
  })

  it('opens the palette sub-tab on the mode on screen', async () => {
    useThemeStore.setState({ resolvedTheme: 'dark' })
    await mount()
    expect(byRole('tab', 'settings.appearance.mode.dark').getAttribute('aria-selected')).toBe(
      'true'
    )
    expect(useThemeStore.getState().previewTheme).toBeNull()
  })
})

describe('preview of the other mode', () => {
  it('previews the Dark palette on the whole window while its sub-tab is selected', async () => {
    await mount()
    await click(byRole('tab', 'settings.appearance.mode.dark'))
    expect(useThemeStore.getState().previewTheme).toBe('dark')
    expect(container.textContent).toContain('settings.appearance.previewNote')
    await click(byRole('tab', 'settings.appearance.mode.light'))
    expect(useThemeStore.getState().previewTheme).toBeNull()
  })

  it('ends the preview when the panel goes away', async () => {
    await mount()
    await click(byRole('tab', 'settings.appearance.mode.dark'))
    act(() => root?.unmount())
    root = null
    expect(useThemeStore.getState().previewTheme).toBeNull()
  })
})

describe('palette cards (CA-35)', () => {
  it('is one single-choice group with one keyboard stop', async () => {
    await mount()
    const group = byRole('radiogroup', 'settings.appearance.colorThemes')
    const radios = [...group.querySelectorAll<HTMLElement>('[role="radio"]')]
    expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual([
      'settings.appearance.presets.original',
      'settings.appearance.presets.paper',
      'settings.appearance.presets.ocean',
      'settings.appearance.presets.forest',
      'settings.appearance.presets.custom'
    ])
    expect(radios.filter((r) => r.tabIndex === 0)).toHaveLength(1)
    expect(radios[2].getAttribute('aria-checked')).toBe('true')
  })

  it('moves the selection with the arrow keys, applying it', async () => {
    await mount()
    const ocean = byRole('radio', 'settings.appearance.presets.ocean')
    await key(ocean, 'ArrowRight')
    expect(useAppearanceStore.getState().prefs.light.selected).toBe('forest')
    expect(useAppearanceStore.getState().drafts.light).toBeTruthy()
    await act(async () => {
      vi.advanceTimersByTime(COMMIT_DELAY_MS)
    })
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ light: { selected: 'forest', custom } })
    )
  })

  it('applies and saves a clicked preset at once', async () => {
    await mount()
    await click(byRole('radio', 'settings.appearance.presets.paper'))
    expect(set).toHaveBeenCalledWith({ ...stored, light: { selected: 'paper', custom } })
  })

  it('shows Original as the way back, keeping the Custom values', async () => {
    await mount()
    await click(byRole('radio', 'settings.appearance.presets.original'))
    expect(set).toHaveBeenLastCalledWith({ ...stored, light: { selected: 'original', custom } })
    // Saved: no draft left, and Original means no overrides at all.
    expect(useAppearanceStore.getState().drafts.light).toBeUndefined()
    expect(useAppearanceStore.getState().palettes.light).toBeNull()
  })
})

describe('Custom', () => {
  it('shows the controls only while Custom is selected', async () => {
    await mount()
    expect(container.querySelectorAll('[role="slider"]')).toHaveLength(0)
    expect(container.textContent).toContain('settings.appearance.customHint')
    await click(byRole('radio', 'settings.appearance.presets.custom'))
    expect(container.querySelectorAll('[role="slider"]')).toHaveLength(4)
  })

  it('starts a never-customized mode from the selected preset (CA-25)', async () => {
    stored = { schemaVersion: 1, light: { selected: 'forest' }, dark: { selected: 'original' } }
    useAppearanceStore.setState({ prefs: stored })
    await mount()
    const customCard = byRole('radio', 'settings.appearance.presets.custom')
    expect(customCard.getAttribute('data-first-use')).toBe('true')
    await click(customCard)
    const hue = byRole('slider', 'settings.appearance.controls.hue')
    expect(hue.getAttribute('aria-valuenow')).toBe(
      String(findPreset('light', 'forest')!.params.hue)
    )
  })

  it('copies the selected preset into Custom (CA-24)', async () => {
    await mount()
    await click(button('settings.appearance.customize'))
    expect(set).toHaveBeenLastCalledWith({
      ...stored,
      light: { selected: 'custom', custom: findPreset('light', 'ocean')!.params }
    })
  })

  it('labels the lightness control by mode', async () => {
    await mount()
    await click(byRole('radio', 'settings.appearance.presets.custom'))
    expect(byRole('slider', 'settings.appearance.controls.brightness')).toBeTruthy()
    await click(byRole('tab', 'settings.appearance.mode.dark'))
    await click(byRole('radio', 'settings.appearance.presets.custom'))
    expect(byRole('slider', 'settings.appearance.controls.darkness')).toBeTruthy()
  })

  it('batches keyboard steps into one save (CA-17)', async () => {
    stored = {
      schemaVersion: 1,
      light: { selected: 'custom', custom },
      dark: { selected: 'original' }
    }
    useAppearanceStore.setState({ prefs: stored })
    await mount()
    const hue = byRole('slider', 'settings.appearance.controls.hue')
    for (let i = 0; i < 3; i++) await key(hue, 'ArrowRight')
    expect(hue.getAttribute('aria-valuenow')).toBe('33')
    expect(set).not.toHaveBeenCalled()
    await act(async () => {
      vi.advanceTimersByTime(COMMIT_DELAY_MS)
    })
    expect(set).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledWith({
      ...stored,
      light: { selected: 'custom', custom: { ...custom, hue: 33 } }
    })
  })

  it('says when Hue cannot be seen', async () => {
    stored = {
      schemaVersion: 1,
      light: { selected: 'custom', custom: { ...custom, intensity: 0, surfaceTint: 0 } },
      dark: { selected: 'original' }
    }
    useAppearanceStore.setState({ prefs: stored })
    await mount()
    expect(container.textContent).toContain('settings.appearance.hueNoEffect')
  })
})

describe('Revert changes (CA-18, CA-19)', () => {
  it('is disabled until something changes, then returns everything to how it was', async () => {
    await mount()
    const revert = button('settings.appearance.revert')
    expect(revert.disabled).toBe(true)
    await click(byRole('radio', 'settings.appearance.presets.forest'))
    expect(button('settings.appearance.revert').disabled).toBe(false)
    await click(button('settings.appearance.revert'))
    expect(set).toHaveBeenLastCalledWith(stored)
    expect(button('settings.appearance.revert').disabled).toBe(true)
  })
})

describe('environment and errors', () => {
  it('surfaces a failed save with a retry (CA-33)', async () => {
    set.mockImplementationOnce(async () => {
      throw new Error('EACCES')
    })
    await mount()
    await click(byRole('radio', 'settings.appearance.presets.forest'))
    const alert = container.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('settings.appearance.saveError')
    await click(button('settings.appearance.retry'))
    expect(set).toHaveBeenCalledTimes(2)
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('explains that the system high-contrast colours take precedence (CA-34)', async () => {
    forcedColors = true
    await mount()
    expect(container.textContent).toContain('settings.appearance.forcedColors')
  })
})
