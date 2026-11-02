import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { WindowPlatform } from '../../../shared/types'

vi.mock('react-i18next', () => ({
  useTranslation: (): { t: (k: string) => string } => ({ t: (key: string) => key })
}))

import { PopoutTitleBar } from './PopoutTitleBar'

interface WindowApiMock {
  selfMinimize: ReturnType<typeof vi.fn>
  selfMaximizeToggle: ReturnType<typeof vi.fn>
  selfClose: ReturnType<typeof vi.fn>
  selfIsMaximized: ReturnType<typeof vi.fn>
  getPlatform: ReturnType<typeof vi.fn>
  onMaximizedChanged: ReturnType<typeof vi.fn>
  onFocusChanged: ReturnType<typeof vi.fn>
}

function setupApi(platform: WindowPlatform): WindowApiMock {
  const api: WindowApiMock = {
    selfMinimize: vi.fn().mockResolvedValue(undefined),
    selfMaximizeToggle: vi.fn().mockResolvedValue(undefined),
    selfClose: vi.fn().mockResolvedValue(undefined),
    selfIsMaximized: vi.fn().mockResolvedValue(false),
    getPlatform: vi.fn().mockResolvedValue(platform),
    onMaximizedChanged: vi.fn().mockReturnValue(() => {}),
    onFocusChanged: vi.fn().mockReturnValue(() => {})
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).api = { window: api }
  return api
}

async function mount(): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<PopoutTitleBar />)
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  return { container, root }
}

function unmount(root: Root, container: HTMLDivElement): void {
  act(() => root.unmount())
  container.remove()
}

function windowControls(c: HTMLDivElement): HTMLButtonElement[] {
  return Array.from(
    c.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="titlebar.minimize"], button[aria-label="titlebar.maximize"], button[aria-label="titlebar.restore"], button[aria-label="titlebar.close"]'
    )
  )
}

describe('PopoutTitleBar', () => {
  let root: Root
  let container: HTMLDivElement

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).api = undefined
  })

  afterEach(() => {
    if (root && container) unmount(root, container)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).api
  })

  it('renders three window buttons on Windows', async () => {
    setupApi('win32')
    ;({ container, root } = await mount())
    expect(windowControls(container)).toHaveLength(3)
  })

  it('renders three window buttons on Linux', async () => {
    setupApi('linux')
    ;({ container, root } = await mount())
    expect(windowControls(container)).toHaveLength(3)
  })

  it('renders no window buttons on macOS', async () => {
    setupApi('darwin')
    ;({ container, root } = await mount())
    expect(windowControls(container)).toHaveLength(0)
  })

  it('wires each button to the sender-scoped self* API', async () => {
    const api = setupApi('win32')
    ;({ container, root } = await mount())
    const minimizeBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="titlebar.minimize"]'
    )
    const maximizeBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="titlebar.maximize"]'
    )
    const closeBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="titlebar.close"]'
    )

    await act(async () => {
      minimizeBtn!.click()
    })
    expect(api.selfMinimize).toHaveBeenCalledTimes(1)

    await act(async () => {
      maximizeBtn!.click()
    })
    expect(api.selfMaximizeToggle).toHaveBeenCalledTimes(1)

    await act(async () => {
      closeBtn!.click()
    })
    expect(api.selfClose).toHaveBeenCalledTimes(1)
  })
})
