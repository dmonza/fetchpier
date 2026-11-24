/**
 * The Enter key dialog's rejection messages: each `SecretsEnterKeyResult.reason`
 * maps to its own copy (ISS-0205 adds the unreadable-keystore one).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { SecretsEnterKeyResult } from '../../../shared/types'
import { useSecretsStore } from '../../stores/secrets'
import { EnterKeyDialog } from './EnterKeyDialog'

let root: Root | null = null

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = null
  document.body.innerHTML = ''
})

async function submitWith(result: SecretsEnterKeyResult): Promise<{ onUnlocked: () => void }> {
  useSecretsStore.setState({ enterKey: vi.fn().mockResolvedValue(result) })
  const onUnlocked = vi.fn()
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      <EnterKeyDialog
        expectedKeyId="0123456789abcdef"
        onClose={() => undefined}
        onUnlocked={onUnlocked}
      />
    )
  })
  const input = document.body.querySelector('input')!
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setValue.call(input, 'FPK1-abc')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const unlock = [...document.body.querySelectorAll('button')].find(
    (b) => b.textContent === 'secrets.enterKey.unlock'
  )!
  await act(async () => {
    unlock.click()
    await Promise.resolve()
    await Promise.resolve()
  })
  return { onUnlocked }
}

describe('EnterKeyDialog', () => {
  it('an unreadable keystore shows its own message and does not unlock', async () => {
    const { onUnlocked } = await submitWith({
      ok: false,
      reason: 'keystore-unreadable',
      keyId: '0123456789abcdef'
    })
    const body = document.body.textContent ?? ''
    expect(body).toContain('secrets.enterKey.keystoreUnreadable')
    expect(body).not.toContain('secrets.enterKey.wrongKey')
    expect(onUnlocked).not.toHaveBeenCalled()
  })

  it('a wrong key keeps the wrong-key message', async () => {
    await submitWith({ ok: false, reason: 'wrong-key', keyId: '0123456789abcdef' })
    expect(document.body.textContent ?? '').toContain('secrets.enterKey.wrongKey')
  })
})
