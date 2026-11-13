/**
 * SEC-12 — the guarded key-delete dialog surfaces a refusal from main instead of
 * dropping it: `KEY_IN_USE` (a workspace became readable since the listing)
 * refreshes the listing and moves the dialog into its blocked copy naming the
 * users; any other failure shows a translated message. Neither closes the dialog.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { WorkspaceKeyMetadata } from '../../../shared/types'

vi.mock('react-i18next', () => ({
  useTranslation: (): { t: (k: string, opts?: Record<string, unknown>) => string } => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key
  })
}))

import { DeleteWorkspaceKeyDialog } from './DeleteWorkspaceKeyDialog'

const ENTRY = {
  keyId: 'abcd1234abcd1234',
  workspaceHint: 'acme-api'
} as WorkspaceKeyMetadata

let deleteKey: ReturnType<typeof vi.fn>
let listKeys: ReturnType<typeof vi.fn>
let onClose: ReturnType<typeof vi.fn<() => void>>
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  deleteKey = vi.fn()
  listKeys = vi.fn().mockResolvedValue({
    entries: [ENTRY],
    references: { byKeyId: {}, incomplete: false }
  })
  onClose = vi.fn<() => void>()
  vi.stubGlobal('api', { secrets: { deleteKey, listKeys } })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function mount(): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(<DeleteWorkspaceKeyDialog entry={ENTRY} onClose={onClose} />)
  })
}

async function confirmDelete(): Promise<void> {
  const input = document.body.querySelector<HTMLInputElement>(
    'input[placeholder="workspaceKeys.delete.inputPlaceholder"]'
  )!
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, 'acme-api')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const button = Array.from(document.body.querySelectorAll('button')).find(
    (b) => b.textContent === 'workspaceKeys.delete.confirm'
  )!
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const bodyText = (): string => document.body.textContent ?? ''

describe('DeleteWorkspaceKeyDialog — refusals from main (SEC-12)', () => {
  it('KEY_IN_USE refreshes the listing and shows the blocked copy naming the users', async () => {
    deleteKey.mockRejectedValue(
      new Error(
        "Error invoking remote method 'secrets:deleteKey': Error: KEY_IN_USE: acme-api, billing"
      )
    )
    await mount()
    await confirmDelete()

    expect(listKeys).toHaveBeenCalledTimes(1)
    expect(bodyText()).toContain('workspaceKeys.delete.blocked.title')
    expect(bodyText()).toContain(
      `workspaceKeys.delete.blocked.body:${JSON.stringify({ names: 'acme-api, billing' })}`
    )
    expect(onClose).not.toHaveBeenCalled()
  })

  it('any other failure shows a translated message, never the raw error, and stays open', async () => {
    deleteKey.mockRejectedValue(
      new Error("Error invoking remote method 'secrets:deleteKey': Error: EACCES: keystore.json")
    )
    await mount()
    await confirmDelete()

    expect(bodyText()).toContain('workspaceKeys.delete.failed')
    expect(bodyText()).not.toContain('EACCES')
    expect(bodyText()).not.toContain('workspaceKeys.delete.blocked.title')
    expect(onClose).not.toHaveBeenCalled()
    const button = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent === 'workspaceKeys.delete.confirm'
    )!
    expect(button.disabled).toBe(false) // the user can retry
  })

  it('a successful delete closes the dialog with no message', async () => {
    deleteKey.mockResolvedValue(undefined)
    await mount()
    await confirmDelete()

    expect(deleteKey).toHaveBeenCalledWith(ENTRY.keyId)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(bodyText()).not.toContain('workspaceKeys.delete.failed')
  })
})
