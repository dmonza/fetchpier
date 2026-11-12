/**
 * Workspace Settings → Appearance inside the real dialog (requirement
 * *Workspace color palettes* §6.2, §6.4): the session over the workspace's
 * palettes, the see-through backdrop and outside-click rule of that tab only,
 * Escape during a drag, and the HTTP reset leaving the appearance alone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

vi.mock('react-i18next', () => ({
  useTranslation: (): { t: (k: string) => string } => ({ t: (key: string) => key })
}))
vi.mock('../settings/CertificatesPanel', () => ({ CertificatesPanel: () => null }))
// The workspace store reaches the i18n instance; keys are enough here.
vi.mock('../../i18n', () => ({ i18next: { t: (k: string) => k } }))

import { WorkspaceSettingsDialog } from './WorkspaceSettingsDialog'
import { useAppearanceStore } from '../../stores/appearance'
import { useThemeStore } from '../../stores/theme'
import { useWorkspaceStore } from '../../stores/workspace'
import { useToastStore } from '../../stores/toast'
import type { AppearancePalettes } from '../../../shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const user: AppearancePalettes = {
  schemaVersion: 1,
  light: { selected: 'ocean' },
  dark: { selected: 'original' }
}
const ws: AppearancePalettes = {
  schemaVersion: 1,
  light: { selected: 'inherit' },
  dark: { selected: 'forest' }
}

let container: HTMLDivElement
let root: Root
let setWorkspace: ReturnType<typeof vi.fn>
let updateHttpSettings: ReturnType<typeof vi.fn>
let open = true

function Harness(): React.JSX.Element {
  return (
    <WorkspaceSettingsDialog
      open={open}
      onOpenChange={(next) => {
        open = next
        root.render(<Harness />)
      }}
    />
  )
}

beforeEach(() => {
  open = true
  setWorkspace = vi.fn(async (p: AppearancePalettes) => ({
    prefs: user,
    workspace: p,
    palettes: { light: null, dark: null }
  }))
  updateHttpSettings = vi.fn(async (p: unknown) => p)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  )
  ;(window as unknown as { api: unknown }).api = {
    workspace: { getHttpSettings: vi.fn(async () => ({})), updateHttpSettings },
    appearance: {
      initial: { light: null, dark: null },
      get: vi.fn(),
      set: vi.fn(),
      setWorkspace,
      onChanged: vi.fn(() => () => undefined)
    },
    theme: {
      setNativeTheme: vi.fn(),
      onSystemChanged: vi.fn(() => () => undefined),
      initialResolved: 'light'
    }
  }
  useAppearanceStore.getState().reset()
  useAppearanceStore.setState({ prefs: user, workspace: ws })
  useThemeStore.setState({ theme: 'light', resolvedTheme: 'light', previewTheme: null })
  useWorkspaceStore.setState({ workspacePath: '/ws' })
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

async function mount(): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(<Harness />)
  })
  await settle()
}

const dialog = (): HTMLElement | null => document.querySelector('[role="dialog"]')
const overlay = (): HTMLElement | null => document.querySelector('[data-slot="dialog-overlay"]')
const byText = (text: string): HTMLElement => {
  const el = [...document.querySelectorAll<HTMLElement>('button, [role="tab"]')].find(
    (b) => b.textContent === text || b.getAttribute('aria-label') === text
  )
  if (!el) throw new Error(`no control ${text}`)
  return el
}
async function press(el: HTMLElement): Promise<void> {
  await act(async () => {
    // Radix tabs select on pointer down / focus; a click covers buttons.
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    el.click()
  })
  await settle()
}
async function clickOutside(): Promise<void> {
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    await act(async () => {
      ;(overlay() ?? document.body).dispatchEvent(
        new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 })
      )
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

describe('Workspace Settings → Appearance', () => {
  it('captures the workspace palettes when the dialog opens', async () => {
    await mount()
    expect(useAppearanceStore.getState().snapshot).toEqual({
      scope: 'workspace',
      prefs: ws,
      theme: 'light'
    })
  })

  it('makes the backdrop see-through and ignores outside clicks on Appearance only (CA-20)', async () => {
    await mount()
    expect(overlay()?.className).toContain('bg-black/60')
    await press(byText('workspaceSettings.tabs.appearance'))
    expect(overlay()?.className).toContain('bg-transparent')
    await clickOutside()
    expect(dialog()).not.toBeNull()

    await press(byText('workspaceSettings.tabs.http'))
    expect(overlay()?.className).toContain('bg-black/60')
    await clickOutside()
    expect(dialog()).toBeNull()
    expect(useAppearanceStore.getState().snapshot).toBeNull()
  })

  it('cancels a drag on Escape without closing (CA-20)', async () => {
    await mount()
    await press(byText('workspaceSettings.tabs.appearance'))
    act(() => {
      useAppearanceStore.getState().beginDrag('dark', 'workspace')
      useAppearanceStore.getState().preview('dark', { canvas: '#010203' })
    })
    await escape()
    expect(dialog()).not.toBeNull()
    expect(useAppearanceStore.getState().dragging).toBeNull()
    expect(setWorkspace).not.toHaveBeenCalled()
  })

  it('leaves the appearance alone when the HTTP settings are reset (CA-18)', async () => {
    await mount()
    await press(byText('workspaceSettings.resetFactory'))
    const confirm = [...document.querySelectorAll('button')].filter(
      (b) => b.textContent === 'workspaceSettings.resetFactory'
    )
    await press(confirm[confirm.length - 1])
    expect(updateHttpSettings).toHaveBeenCalled()
    expect(setWorkspace).not.toHaveBeenCalled()
    expect(useAppearanceStore.getState().workspace).toEqual(ws)
  })

  // WSP-01: a refused write (an unparseable settings.json) reaches the user.
  it('shows the error when the HTTP settings write is refused', async () => {
    updateHttpSettings.mockRejectedValueOnce(new Error('Workspace settings could not be read'))
    useToastStore.setState({ messages: [] })
    await mount()
    await press(byText('workspaceSettings.resetFactory'))
    const confirm = [...document.querySelectorAll('button')].filter(
      (b) => b.textContent === 'workspaceSettings.resetFactory'
    )
    await press(confirm[confirm.length - 1])
    expect(useToastStore.getState().messages).toEqual([
      expect.objectContaining({
        type: 'error',
        message: 'workspaceSettings.saveFailed'
      })
    ])
  })

  it('offers the HTTP reset on the HTTP tab only (CA-21)', async () => {
    const resetOffered = (): boolean =>
      [...document.querySelectorAll('button')].some(
        (b) => b.textContent === 'workspaceSettings.resetFactory'
      )
    await mount()
    expect(resetOffered()).toBe(true)
    await press(byText('workspaceSettings.tabs.appearance'))
    expect(resetOffered()).toBe(false)
    // It resets the HTTP settings, so it is not offered beside the certificates.
    await press(byText('workspaceSettings.tabs.certificates'))
    expect(resetOffered()).toBe(false)
    await press(byText('workspaceSettings.tabs.http'))
    expect(resetOffered()).toBe(true)
  })

  it('keeps Done in the footer on every tab', async () => {
    await mount()
    for (const name of ['http', 'certificates', 'appearance']) {
      await press(byText(`workspaceSettings.tabs.${name}`))
      expect(byText('workspaceSettings.done')).toBeTruthy()
      const scroll = document.querySelector('[role="tabpanel"][data-state="active"]')
      expect(scroll?.contains(byText('workspaceSettings.done'))).toBe(false)
    }
  })
})
