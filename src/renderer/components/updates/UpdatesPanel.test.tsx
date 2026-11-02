import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { OPEN_UPDATES_EVENT } from '../../lib/events'
import { PRODUCT_RELEASES_URL } from '../../../shared/types'

vi.mock('react-i18next', () => ({
  useTranslation: (): { t: (k: string) => string } => ({ t: (key: string) => key })
}))

vi.mock('../../stores/appSettings', () => ({
  useAppSettingsStore: <T,>(selector: (s: { setUpdates: () => Promise<void> }) => T): T =>
    selector({ setUpdates: () => Promise.resolve() })
}))

import { UpdatesPanel } from './UpdatesPanel'

function buttonByText(text: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.textContent?.trim() === text
  )
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('UpdatesPanel', () => {
  let root: Root
  let container: HTMLDivElement
  let openExternal: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    openExternal = vi.fn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).api = {
      app: { openExternal },
      updates: {
        check: vi.fn().mockResolvedValue({
          ok: true,
          data: {
            currentVersion: '0.9.4',
            publishedVersion: '0.9.5',
            isNewer: true,
            fetchedAt: '2026-10-27T00:00:00.000Z'
          }
        })
      }
    }
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(<UpdatesPanel />)
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).api
  })

  it('sends the user to the GitHub Releases page when a newer version is available', async () => {
    await act(async () => {
      window.dispatchEvent(new Event(OPEN_UPDATES_EVENT))
    })
    await act(async () => {
      buttonByText('updates.check')?.click()
    })
    await flush()

    const download = buttonByText('updates.openReleases')
    expect(download).toBeDefined()
    await act(async () => {
      download?.click()
    })
    expect(openExternal).toHaveBeenCalledWith(PRODUCT_RELEASES_URL)
  })
})
