/**
 * `stampLastVersion` records the version the About was shown for. Showing the
 * About for a version already stored must not rewrite the settings file, so a
 * manual open is a pure no-op.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, UpdatesSettings } from '../../shared/types'
import { shouldAutoOpenUpdates, useAppSettingsStore } from './appSettings'

const get = vi.fn()
const set = vi.fn()

function appSettings(lastVersion: string | null): AppSettings {
  return {
    zoomFactor: 1,
    language: 'en',
    requestTimeoutSeconds: 30,
    proxy: { enabled: false, url: '', username: '', password: '' },
    lastVersion,
    updates: { intervalDays: 15, lastCheckAt: null, autoCheckEnabled: true },
    theme: 'system'
  }
}

beforeEach(() => {
  get.mockReset()
  set.mockReset()
  set.mockResolvedValue(appSettings('0.9.2'))
  vi.stubGlobal('window', { ...window, api: { appSettings: { get, set } } })
})

describe('stampLastVersion', () => {
  it('persists the current version when the stored one differs', async () => {
    get.mockResolvedValue(appSettings('0.9.1'))
    await useAppSettingsStore.getState().stampLastVersion('0.9.2')
    expect(set).toHaveBeenCalledWith({ lastVersion: '0.9.2' })
  })

  it('persists the current version on a fresh install', async () => {
    get.mockResolvedValue(appSettings(null))
    await useAppSettingsStore.getState().stampLastVersion('0.9.2')
    expect(set).toHaveBeenCalledWith({ lastVersion: '0.9.2' })
  })

  it('writes nothing when the stored version already matches', async () => {
    get.mockResolvedValue(appSettings('0.9.2'))
    await useAppSettingsStore.getState().stampLastVersion('0.9.2')
    expect(set).not.toHaveBeenCalled()
  })

  it('never throws when the settings file cannot be read', async () => {
    get.mockRejectedValue(new Error('EACCES'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(useAppSettingsStore.getState().stampLastVersion('0.9.2')).resolves.toBeUndefined()
    expect(set).not.toHaveBeenCalled()
  })
})

describe('shouldAutoOpenUpdates', () => {
  const base: UpdatesSettings = { intervalDays: 15, lastCheckAt: null, autoCheckEnabled: true }
  const now = Date.parse('2026-07-10T00:00:00Z')
  const day = 24 * 60 * 60 * 1000

  it('never prompts when auto-check is disabled', () => {
    expect(shouldAutoOpenUpdates({ ...base, autoCheckEnabled: false }, now)).toBe(false)
  })

  it('prompts when never checked', () => {
    expect(shouldAutoOpenUpdates(base, now)).toBe(true)
  })

  it('prompts when the interval has elapsed', () => {
    const lastCheckAt = new Date(now - 15 * day).toISOString()
    expect(shouldAutoOpenUpdates({ ...base, lastCheckAt }, now)).toBe(true)
  })

  it('stays quiet inside the interval', () => {
    const lastCheckAt = new Date(now - 2 * day).toISOString()
    expect(shouldAutoOpenUpdates({ ...base, lastCheckAt }, now)).toBe(false)
  })

  it('prompts when the stored timestamp is unparseable', () => {
    expect(shouldAutoOpenUpdates({ ...base, lastCheckAt: 'not-a-date' }, now)).toBe(true)
  })
})
