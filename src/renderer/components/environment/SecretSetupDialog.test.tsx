/**
 * The one-time key dialog. It can only be dismissed through the acknowledgment,
 * so it shows no header close button. ISS-0135: a rotation whose rollback could
 * not put every file back still shows the new key, and names the files left
 * under it. The rotation behavior itself is proven in the secrets service.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

vi.mock('react-i18next', () => ({
  useTranslation: (): { t: (k: string, opts?: Record<string, unknown>) => string } => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key
  })
}))

import { SecretSetupDialog } from './SecretSetupDialog'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.replaceChildren()
})

function render(strandedFiles?: string[]): void {
  act(() => {
    root.render(
      <SecretSetupDialog
        workspaceKey="FPK1-TEST"
        keyId="abc123"
        variant="rotated"
        strandedFiles={strandedFiles}
        onAcknowledge={() => undefined}
      />
    )
  })
}

const text = (): string => document.body.textContent ?? ''

describe('SecretSetupDialog first-time setup', () => {
  it('hides the header close button and requires acknowledgment before confirming', () => {
    const onAcknowledge = vi.fn()
    act(() => {
      root.render(
        <SecretSetupDialog
          workspaceKey="FPK1-TEST-KEY"
          keyId="kid-123"
          variant="setup"
          onAcknowledge={onAcknowledge}
        />
      )
    })

    // No "Close" button should be rendered since dismissal is gated by acknowledgment.
    const closeButtons = [...document.body.querySelectorAll('button')].filter(
      (b) => b.textContent?.trim() === 'Close'
    )
    expect(closeButtons).toHaveLength(0)

    const confirmBtn = [...document.body.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('secrets.setup.confirm')
    ) as HTMLButtonElement
    expect(confirmBtn).toBeDefined()
    expect(confirmBtn.disabled).toBe(true)

    const checkbox = document.body.querySelector('input[type="checkbox"]') as HTMLInputElement
    act(() => {
      checkbox.click()
    })
    expect(confirmBtn.disabled).toBe(false)

    act(() => {
      confirmBtn.click()
    })
    expect(onAcknowledge).toHaveBeenCalledTimes(1)
  })
})

describe('SecretSetupDialog after a rotation', () => {
  it('shows the new key under the usual title when the rotation completed', () => {
    render()

    expect(text()).toContain('secrets.rotate.doneTitle')
    expect(text()).toContain('FPK1-TEST')
    expect(document.body.querySelector('[data-rotation-stranded]')).toBeNull()
  })

  it('names the files left under the new key when the rotation could not be undone', () => {
    render(['environments/dev/config.json', 'environments/dev/.state/localvalues.json'])

    expect(text()).toContain('secrets.rotate.incompleteTitle')
    expect(text()).not.toContain('secrets.rotate.doneTitle')
    expect(text()).toContain('FPK1-TEST')
    const notice = document.body.querySelector('[data-rotation-stranded]')
    expect(notice?.getAttribute('role')).toBe('alert')
    expect(notice?.textContent).toContain('secrets.rotate.incompleteBody')
    const items = [...(notice?.querySelectorAll('li') ?? [])].map((li) => li.textContent)
    expect(items).toEqual([
      'environments/dev/config.json',
      'environments/dev/.state/localvalues.json'
    ])
  })

  it('an empty list is treated as a completed rotation', () => {
    render([])

    expect(text()).toContain('secrets.rotate.doneTitle')
    expect(document.body.querySelector('[data-rotation-stranded]')).toBeNull()
  })
})
