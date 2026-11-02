import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useKeyboardShortcuts } from './useKeyboardShortcuts'
import { deriveMenuEnablement, type MenuItemId, type MenuState } from '@shared/menu-model'

/** A fully-usable window with a workspace and an active tab. */
const FULL_STATE: MenuState = {
  hasWindow: true,
  rendererReady: true,
  hasWorkspace: true,
  hasAnyTab: true,
  hasActiveTab: true,
  focusedWindow: 'main'
}

function makeHandlers(state: MenuState = FULL_STATE) {
  const enablement = deriveMenuEnablement(state)
  return {
    isEnabled: vi.fn((id: MenuItemId) => enablement[id]),
    onSendRequest: vi.fn(),
    onNewRequest: vi.fn(),
    onNewCollection: vi.fn(),
    onOpenWorkspace: vi.fn(),
    onCloseTab: vi.fn(),
    onCloseWindow: vi.fn(),
    onSaveRequest: vi.fn(),
    onOpenCommandPalette: vi.fn(),
    onFocusUrlBar: vi.fn(),
    onToggleSidebar: vi.fn(),
    onToggleActivityPanel: vi.fn(),
    onZoom: vi.fn(),
    onNextTab: vi.fn(),
    onPrevTab: vi.fn(),
    onPageNextTab: vi.fn(),
    onPagePrevTab: vi.fn(),
    onTabCycleEnd: vi.fn()
  }
}

let container: HTMLDivElement
let root: Root

function mount(handlers: ReturnType<typeof makeHandlers>): void {
  function Probe(): null {
    useKeyboardShortcuts(handlers)
    return null
  }
  act(() => {
    root.render(<Probe />)
  })
}

function keydown(init: KeyboardEventInit): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', init))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('useKeyboardShortcuts — tab switching', () => {
  it('Ctrl+Tab steps MRU forward; Ctrl+Shift+Tab steps backward', () => {
    const h = makeHandlers()
    mount(h)
    keydown({ key: 'Tab', ctrlKey: true })
    expect(h.onNextTab).toHaveBeenCalledTimes(1)
    keydown({ key: 'Tab', ctrlKey: true, shiftKey: true })
    expect(h.onPrevTab).toHaveBeenCalledTimes(1)
  })

  it('Ctrl+PageDown / Ctrl+PageUp page through tab-bar order', () => {
    const h = makeHandlers()
    mount(h)
    keydown({ key: 'PageDown', ctrlKey: true })
    keydown({ key: 'PageUp', ctrlKey: true })
    expect(h.onPageNextTab).toHaveBeenCalledTimes(1)
    expect(h.onPagePrevTab).toHaveBeenCalledTimes(1)
  })

  it('releasing Ctrl ends the MRU cycle', () => {
    const h = makeHandlers()
    mount(h)
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control' }))
    })
    expect(h.onTabCycleEnd).toHaveBeenCalledTimes(1)
  })
})

// REQ menu coherence §6.8 — closing follows the desktop-editor convention.
describe('useKeyboardShortcuts — close commands', () => {
  it('Ctrl+W closes the active tab while one is open', () => {
    const h = makeHandlers()
    mount(h)
    keydown({ key: 'w', ctrlKey: true })
    expect(h.onCloseTab).toHaveBeenCalledTimes(1)
    expect(h.onCloseWindow).not.toHaveBeenCalled()
  })

  // CA-10 — the fallback: once no tab is left, the same shortcut closes the
  // window, so it is never inert.
  it('Ctrl+W closes the window when no tab is open', () => {
    const h = makeHandlers({ ...FULL_STATE, hasAnyTab: false, hasActiveTab: false })
    mount(h)
    keydown({ key: 'w', ctrlKey: true })
    expect(h.onCloseTab).not.toHaveBeenCalled()
    expect(h.onCloseWindow).toHaveBeenCalledTimes(1)
  })

  // CA-11 — the shifted one always closes the window, never the tabs.
  it('Ctrl+Shift+W closes the window even with tabs open', () => {
    const h = makeHandlers()
    mount(h)
    // With Shift held, the browser reports the key as uppercase 'W'.
    keydown({ key: 'W', ctrlKey: true, shiftKey: true })
    expect(h.onCloseWindow).toHaveBeenCalledTimes(1)
    expect(h.onCloseTab).not.toHaveBeenCalled()
  })
})

// CA-09 — the gate is what stops a shortcut from doing what the menu refuses.
// It matters because a disabled menu item does not swallow its key equivalent.
describe('useKeyboardShortcuts — enablement gate', () => {
  it('does nothing for actions the menu would offer as disabled', () => {
    const h = makeHandlers({ ...FULL_STATE, hasWorkspace: false })
    mount(h)

    keydown({ key: 'N', ctrlKey: true, shiftKey: true })

    expect(h.onNewCollection).not.toHaveBeenCalled()
  })

  it('does nothing at all while the interface is not ready', () => {
    const h = makeHandlers({ ...FULL_STATE, rendererReady: false })
    mount(h)

    keydown({ key: 'n', ctrlKey: true })
    keydown({ key: 's', ctrlKey: true })
    keydown({ key: 'Enter', ctrlKey: true })
    keydown({ key: 'w', ctrlKey: true })

    expect(h.onNewRequest).not.toHaveBeenCalled()
    expect(h.onSaveRequest).not.toHaveBeenCalled()
    expect(h.onSendRequest).not.toHaveBeenCalled()
    expect(h.onCloseTab).not.toHaveBeenCalled()
    expect(h.onCloseWindow).not.toHaveBeenCalled()
  })

  it('still lets an ungated tab-navigation shortcut through', () => {
    const h = makeHandlers({ ...FULL_STATE, hasWorkspace: false })
    mount(h)
    keydown({ key: 'Tab', ctrlKey: true })
    expect(h.onNextTab).toHaveBeenCalledTimes(1)
  })
})

// CA-16 — the shortcuts the menu used to serve on the platforms that draw none.
describe('useKeyboardShortcuts — shortcuts re-established from the menu', () => {
  it('opens a workspace, creates a collection, and zooms', () => {
    const h = makeHandlers()
    mount(h)

    keydown({ key: 'o', ctrlKey: true })
    keydown({ key: 'N', ctrlKey: true, shiftKey: true })
    keydown({ key: '=', ctrlKey: true })
    keydown({ key: '-', ctrlKey: true })
    keydown({ key: '0', ctrlKey: true })

    expect(h.onOpenWorkspace).toHaveBeenCalledTimes(1)
    expect(h.onNewCollection).toHaveBeenCalledTimes(1)
    expect(h.onNewRequest).not.toHaveBeenCalled()
    expect(h.onZoom.mock.calls).toEqual([['in'], ['out'], ['reset']])
  })

  it('creates a request without Shift and a collection with it', () => {
    const h = makeHandlers()
    mount(h)
    keydown({ key: 'n', ctrlKey: true })
    expect(h.onNewRequest).toHaveBeenCalledTimes(1)
    expect(h.onNewCollection).not.toHaveBeenCalled()
  })
})

describe('useKeyboardShortcuts — existing shortcuts still fire', () => {
  it('maps the legacy chords to their handlers', () => {
    const h = makeHandlers()
    mount(h)
    keydown({ key: 'Enter', ctrlKey: true })
    keydown({ key: 'n', ctrlKey: true })
    keydown({ key: 's', ctrlKey: true })
    keydown({ key: 'p', ctrlKey: true })
    keydown({ key: 'l', ctrlKey: true })
    keydown({ key: 'b', ctrlKey: true })
    keydown({ key: 'j', ctrlKey: true })
    expect(h.onSendRequest).toHaveBeenCalledTimes(1)
    expect(h.onNewRequest).toHaveBeenCalledTimes(1)
    expect(h.onSaveRequest).toHaveBeenCalledTimes(1)
    expect(h.onOpenCommandPalette).toHaveBeenCalledTimes(1)
    expect(h.onFocusUrlBar).toHaveBeenCalledTimes(1)
    expect(h.onToggleSidebar).toHaveBeenCalledTimes(1)
    expect(h.onToggleActivityPanel).toHaveBeenCalledTimes(1)
  })

  it('ignores keys pressed without Ctrl/Cmd', () => {
    const h = makeHandlers()
    mount(h)
    keydown({ key: 'Tab' })
    keydown({ key: 'n' })
    expect(h.onNextTab).not.toHaveBeenCalled()
    expect(h.onNewRequest).not.toHaveBeenCalled()
  })
})
