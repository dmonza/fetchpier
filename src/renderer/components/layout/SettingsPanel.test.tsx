/**
 * Settings → General: the "hide secrets in responses" preference. It is on by
 * default (a settings file without it reads as on) and unchecking it writes the
 * app setting the send path reads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

vi.mock('react-i18next', () => ({
  useTranslation: (): { t: (k: string, opts?: Record<string, unknown>) => string } => ({
    t: (key: string) => key
  })
}))

// The dialog primitive portals and animates; the preference under test is plain
// content inside it.
vi.mock('../ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>
}))
vi.mock('../settings/CertificatesPanel', () => ({ CertificatesPanel: () => null }))
vi.mock('../settings/WorkspaceKeysPanel', () => ({ WorkspaceKeysPanel: () => null }))

import { SettingsPanel } from './SettingsPanel'
import { OPEN_SETTINGS_EVENT } from '../../lib/events'

const LABEL = 'settings.responseSecrets.hide'

let container: HTMLDivElement
let root: Root
let set: ReturnType<typeof vi.fn>

function stubApi(stored: Record<string, unknown>): void {
  set = vi.fn(async () => ({}))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).api = {
    appSettings: {
      get: vi.fn(async () => ({ requestTimeoutSeconds: 30, ...stored })),
      set,
      getUpdates: vi.fn(async () => ({
        autoCheckEnabled: true,
        intervalDays: 7,
        lastCheckAt: null
      })),
      setUpdates: vi.fn()
    }
  }
}

async function openSettings(): Promise<HTMLInputElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(<SettingsPanel />)
  })
  await act(async () => {
    window.dispatchEvent(new Event(OPEN_SETTINGS_EVENT))
  })
  const label = Array.from(container.querySelectorAll('label')).find((l) =>
    l.textContent?.includes(LABEL)
  )
  const input = label?.querySelector('input[type="checkbox"]') as HTMLInputElement | null
  if (!input) throw new Error('hide-secrets checkbox not rendered')
  return input
}

beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('Settings → hide secrets in responses', () => {
  it('is checked when the stored setting is on', async () => {
    stubApi({ hideSecretsInResponses: true })
    expect((await openSettings()).checked).toBe(true)
  })

  it('unchecking it writes the setting off', async () => {
    stubApi({ hideSecretsInResponses: true })
    const input = await openSettings()
    await act(async () => {
      input.click()
    })
    expect(set).toHaveBeenCalledWith({ hideSecretsInResponses: false })
    expect(input.checked).toBe(false)
  })

  it('reflects a stored off value', async () => {
    stubApi({ hideSecretsInResponses: false })
    expect((await openSettings()).checked).toBe(false)
  })
})
