/**
 * Secrets IPC: what crosses the boundary when a reveal fails. Custom error
 * properties do not survive `ipcRenderer.invoke`, so the contractual code must
 * travel at the head of the message — the editor tells a corrupt value (offers
 * "Clear and re-enter") from a missing key (offers "Enter key") by it (UI-08).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { secrets } from '@fetchpier/core'

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>): void => {
      handlers.set(channel, fn)
    }
  }
}))

vi.mock('../state/active-workspace', () => ({
  requireActiveWorkspaceHandle: () => ({ path: 'C:/ws' })
}))

const revealValue = vi.fn()
vi.mock('../secrets/service', () => ({ revealValue: (...a: unknown[]) => revealValue(...a) }))
vi.mock('../secrets/local-values', () => ({}))

import { registerSecretsHandlers } from './secrets.ipc'

registerSecretsHandlers()

const reveal = (): Promise<unknown> => handlers.get('secrets:reveal')!(null, 'dev', 'apiToken')

beforeEach(() => {
  revealValue.mockReset()
})

describe('secrets:reveal — failure carries its code', () => {
  it('a missing key reaches the renderer as SECRETS_KEY_MISSING', async () => {
    revealValue.mockRejectedValue(secrets.keyMissingError())
    await expect(reveal()).rejects.toThrow(/^SECRETS_KEY_MISSING: No workspace key available/)
  })

  it('a corrupt value reaches the renderer as SECRETS_VALUE_CORRUPT', async () => {
    revealValue.mockRejectedValue(secrets.valueCorruptError('dev', 'apiToken'))
    await expect(reveal()).rejects.toThrow(/^SECRETS_VALUE_CORRUPT: Secret "apiToken"/)
  })

  it('a non-coded failure passes through unchanged', async () => {
    const plain = new Error('EACCES: permission denied')
    revealValue.mockRejectedValue(plain)
    await expect(reveal()).rejects.toBe(plain)
  })

  it('a success returns the plaintext', async () => {
    revealValue.mockResolvedValue('s3cret')
    await expect(reveal()).resolves.toBe('s3cret')
    expect(revealValue).toHaveBeenCalledWith('C:/ws', 'dev', 'apiToken')
  })
})
