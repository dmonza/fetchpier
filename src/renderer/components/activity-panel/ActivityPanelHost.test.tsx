/**
 * REQ-0104 Stage 5: the resize-drag handle installs a transient `pointermove`
 * listener on `window`, removed on `pointerup`. If the drag instead ends via
 * `pointercancel` (e.g. the OS/browser revokes pointer capture), the listener
 * must still be removed — otherwise it survives indefinitely and a later,
 * unrelated pointer move keeps resizing the panel.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// React 19 requires this flag for act(...) to flush state updates from events.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('./ActivityPanel', () => ({
  ActivityPanel: (): null => null
}))

import { ActivityPanelHost } from './ActivityPanelHost'
import { useActivityPanelStore } from '../../stores/activityPanel'

async function mount(heightPx: number): Promise<{ container: HTMLDivElement; root: Root }> {
  useActivityPanelStore.setState({ isOpen: true, isDetached: false, heightPx })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<ActivityPanelHost />)
  })
  await act(async () => {
    await Promise.resolve()
  })
  return { container, root }
}

function unmount(root: Root, container: HTMLDivElement): void {
  act(() => root.unmount())
  container.remove()
}

describe('ActivityPanelHost — resize drag listener cleanup', () => {
  let root: Root
  let container: HTMLDivElement

  afterEach(() => {
    if (root && container) unmount(root, container)
    useActivityPanelStore.setState({ isOpen: false, isDetached: false, heightPx: null })
  })

  it('CA-13: pointercancel removes the transient pointermove listener, like pointerup does', async () => {
    ;({ container, root } = await mount(400))
    const handle = container.querySelector('[role="separator"]')!

    act(() => {
      handle.dispatchEvent(
        new PointerEvent('pointerdown', { clientY: 500, bubbles: true, cancelable: true })
      )
    })

    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientY: 480, bubbles: true }))
    })
    const afterFirstMove = useActivityPanelStore.getState().heightPx
    expect(afterFirstMove).not.toBe(400) // the drag is live and resizing

    act(() => {
      window.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true }))
    })

    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientY: 300, bubbles: true }))
    })
    // A stale listener would have resized again on this second move.
    expect(useActivityPanelStore.getState().heightPx).toBe(afterFirstMove)
  })

  it('HIS-19: a stored height taller than the current window is clamped when the panel opens', async () => {
    // The window shrank while the panel was closed: no resize listener ran, so
    // the store still holds the old, taller height.
    vi.stubGlobal('innerHeight', 600)
    try {
      ;({ container, root } = await mount(900))
      const host = container.querySelector<HTMLDivElement>('[data-testid="activity-panel-host"]')!
      // 600 - 100 px reserved chrome.
      expect(host.style.height).toBe('500px')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('HIS-19: a drag starts from the clamped height, not the stale stored one', async () => {
    vi.stubGlobal('innerHeight', 600)
    try {
      ;({ container, root } = await mount(900))
      const handle = container.querySelector('[role="separator"]')!
      act(() => {
        handle.dispatchEvent(
          new PointerEvent('pointerdown', { clientY: 500, bubbles: true, cancelable: true })
        )
      })
      // Dragging down 100 px from the visible 500 px panel shrinks it to 400.
      act(() => {
        window.dispatchEvent(new PointerEvent('pointermove', { clientY: 600, bubbles: true }))
      })
      act(() => {
        window.dispatchEvent(new PointerEvent('pointerup', { clientY: 600, bubbles: true }))
      })
      expect(useActivityPanelStore.getState().heightPx).toBe(400)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('pointerup still commits the height and removes the listener (unchanged behavior)', async () => {
    ;({ container, root } = await mount(400))
    const handle = container.querySelector('[role="separator"]')!

    act(() => {
      handle.dispatchEvent(
        new PointerEvent('pointerdown', { clientY: 500, bubbles: true, cancelable: true })
      )
    })
    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientY: 480, bubbles: true }))
    })
    act(() => {
      window.dispatchEvent(new PointerEvent('pointerup', { clientY: 480, bubbles: true }))
    })
    const afterUp = useActivityPanelStore.getState().heightPx

    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientY: 300, bubbles: true }))
    })
    expect(useActivityPanelStore.getState().heightPx).toBe(afterUp)
  })
})
