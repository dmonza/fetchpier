/**
 * The layout both settings dialogs share (plan *Fixed-size settings dialogs*):
 * the tabs are a real tablist, the selected panel is the only region that
 * scrolls — title, tab strip and footer stay outside it — and, while the user
 * judges colours, the backdrop is see-through and an outside click is ignored.
 * Real sizes are measured end to end (SETDLG-001..004); here, the structure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { SettingsDialogShell, SettingsTabPanel } from './SettingsDialogShell'
import { useAppearanceStore } from '../../stores/appearance'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let onOpenChange: ReturnType<typeof vi.fn<(open: boolean) => void>>
let onValueChange: ReturnType<typeof vi.fn<(value: string) => void>>

const TABS = [
  { value: 'one', label: 'One' },
  { value: 'two', label: 'Two' }
]

async function mount(
  props: { judging?: boolean; value?: string; footer?: boolean } = {}
): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(
      <SettingsDialogShell
        open
        onOpenChange={onOpenChange}
        title="Title"
        description="Description"
        tabs={TABS}
        value={props.value ?? 'one'}
        onValueChange={onValueChange}
        judging={props.judging ?? false}
        footer={props.footer === false ? undefined : <button type="button">Footer action</button>}
      >
        <SettingsTabPanel value="one">
          <p>Panel one</p>
        </SettingsTabPanel>
        <SettingsTabPanel value="two">
          <p>Panel two</p>
        </SettingsTabPanel>
      </SettingsDialogShell>
    )
  })
}

beforeEach(() => {
  onOpenChange = vi.fn<(open: boolean) => void>()
  onValueChange = vi.fn<(value: string) => void>()
  ;(window as unknown as { api: unknown }).api = {
    appearance: {
      initial: { light: null, dark: null },
      get: vi.fn(),
      set: vi.fn(),
      setWorkspace: vi.fn(),
      onChanged: vi.fn(() => () => undefined)
    }
  }
  useAppearanceStore.getState().reset()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const content = (): HTMLElement => document.querySelector('[role="dialog"]') as HTMLElement
const overlay = (): HTMLElement | null => document.querySelector('[data-slot="dialog-overlay"]')
// Radix keeps inactive panels in the document, empty and `hidden`.
const panel = (): HTMLElement =>
  document.querySelector('[role="tabpanel"][data-state="active"]') as HTMLElement
const tabs = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[role="tab"]')]
const byText = (text: string): HTMLElement =>
  [...document.querySelectorAll<HTMLElement>('*')].find(
    (el) => el.childElementCount === 0 && el.textContent === text
  ) as HTMLElement

async function clickOutside(): Promise<void> {
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    await act(async () => {
      ;(overlay() ?? document.body).dispatchEvent(
        new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 })
      )
    })
  }
}

describe('SettingsDialogShell', () => {
  it('exposes the tabs as a tablist with the selected one marked', async () => {
    await mount({ value: 'two' })
    expect(document.querySelector('[role="tablist"]')).not.toBeNull()
    expect(tabs().map((t) => t.textContent)).toEqual(['One', 'Two'])
    expect(tabs().map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'true'])
    expect(panel().textContent).toBe('Panel two')
    // The inactive panel keeps no layout of its own: nothing sets a display
    // that would override `hidden`.
    const inactive = document.querySelector('[role="tabpanel"][data-state="inactive"]')
    expect(inactive?.hasAttribute('hidden')).toBe(true)
    expect(inactive?.className).not.toMatch(/(^|\s)(flex|block|grid)(\s|$)/)
  })

  it('reports the tab the user selects', async () => {
    await mount()
    await act(async () => {
      tabs()[1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    })
    expect(onValueChange).toHaveBeenCalledWith('two')
  })

  it('has one fixed size whatever the tab, capped to the window', async () => {
    await mount()
    const one = content().className
    act(() => root.unmount())
    container.remove()
    await mount({ value: 'two', footer: false })
    expect(content().className).toBe(one)
    expect(one).toContain('h-[min(40rem,calc(100dvh-4rem))]')
    expect(one).toContain('max-w-2xl')
  })

  it('scrolls only the panel; the title, tab strip and footer stay outside it', async () => {
    await mount()
    const scroll = panel()
    expect(scroll.className).toContain('overflow-y-auto')
    expect(scroll.className).toContain('min-h-0')
    // Keyboard users can reach and scroll it, with a visible focus ring.
    expect(scroll.getAttribute('tabindex')).toBe('0')
    expect(scroll.className).toContain('focus-visible:ring-1')
    for (const fixed of [
      byText('Title'),
      byText('Description'),
      document.querySelector('[role="tablist"]') as HTMLElement,
      byText('Footer action')
    ]) {
      expect(fixed).toBeTruthy()
      expect(scroll.contains(fixed)).toBe(false)
    }
  })

  it('dims the app and closes on an outside click when not judging colours', async () => {
    await mount({ judging: false })
    expect(overlay()?.className).not.toContain('bg-transparent')
    await clickOutside()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('while judging colours, keeps the app visible and ignores an outside click', async () => {
    await mount({ judging: true })
    expect(overlay()?.className).toContain('bg-transparent')
    expect(content().className).toContain('border-border-strong')
    await clickOutside()
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('cancels a drag on Escape and stays open', async () => {
    await mount({ judging: true })
    act(() => useAppearanceStore.getState().beginDrag('dark'))
    await act(async () => {
      ;(document.activeElement ?? document.body).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
    })
    expect(useAppearanceStore.getState().dragging).toBeNull()
    expect(onOpenChange).not.toHaveBeenCalled()
  })
})
