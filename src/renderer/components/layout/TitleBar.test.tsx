import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { WindowPlatform } from '../../../shared/types'

vi.mock('react-i18next', () => ({
  useTranslation: (): { t: (k: string) => string } => ({ t: (key: string) => key })
}))

vi.mock('../../stores/workspace', () => ({
  useWorkspaceStore: <T,>(selector: (s: { workspacePath: string | null }) => T): T =>
    selector({ workspacePath: null })
}))

import { TitleBar } from './TitleBar'

interface WindowApiMock {
  minimize: ReturnType<typeof vi.fn>
  maximizeToggle: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  isMaximized: ReturnType<typeof vi.fn>
  getPlatform: ReturnType<typeof vi.fn>
  onMaximizedChanged: ReturnType<typeof vi.fn>
  onFocusChanged: ReturnType<typeof vi.fn>
}

function setupApi(platform: WindowPlatform): WindowApiMock {
  const api: WindowApiMock = {
    minimize: vi.fn().mockResolvedValue(undefined),
    maximizeToggle: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    isMaximized: vi.fn().mockResolvedValue(false),
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
    root.render(<TitleBar />)
  })
  // Flush the async getPlatform/isMaximized promises
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

describe('TitleBar', () => {
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

  function windowControls(c: HTMLDivElement): HTMLButtonElement[] {
    return Array.from(
      c.querySelectorAll<HTMLButtonElement>(
        'button[aria-label="titlebar.minimize"], button[aria-label="titlebar.maximize"], button[aria-label="titlebar.restore"], button[aria-label="titlebar.close"]'
      )
    )
  }

  it('titles itself with the translated app name, not a hard-coded string', async () => {
    setupApi('win32')
    ;({ container, root } = await mount())
    const title = container.querySelector('.titlebar .truncate')
    expect(title?.textContent).toBe('about.appName')
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

  it('calls the matching handler when each button is clicked', async () => {
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
    expect(minimizeBtn).not.toBeNull()
    expect(maximizeBtn).not.toBeNull()
    expect(closeBtn).not.toBeNull()

    await act(async () => {
      minimizeBtn!.click()
    })
    expect(api.minimize).toHaveBeenCalledTimes(1)

    await act(async () => {
      maximizeBtn!.click()
    })
    expect(api.maximizeToggle).toHaveBeenCalledTimes(1)

    await act(async () => {
      closeBtn!.click()
    })
    expect(api.close).toHaveBeenCalledTimes(1)
  })
})
