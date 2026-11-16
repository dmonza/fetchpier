import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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
  act(() => {
    root.unmount()
  })
  container.remove()
  document.body.innerHTML = ''
})

describe('SecretSetupDialog', () => {
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
