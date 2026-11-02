/**
 * Backward-compatibility round-trip tests for the new `tls` field across both
 * scope persistence layers. The store itself orchestrates electron + the
 * filesystem + the active workspace, which is fully exercised by the IPC
 * layer in dev. Here we lock the invariant that matters: existing settings
 * files without a `tls` field still load cleanly, and once written they
 * round-trip through both layers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppSettings, TlsScopeSettings } from '../../shared/types'
import {
  loadHttpSettings,
  updateHttpSettings,
  clearHttpSettingsCache
} from '../config/workspace-settings-store'

// electron's app.getPath('userData') is called at module-eval time inside
// appsettings.ipc.ts — stub it before that import runs.
let userDataDir: string

vi.mock('electron', async () => {
  const real = await vi.importActual<typeof import('electron')>('electron')
  return {
    ...real,
    app: {
      getPath: () => userDataDir
    },
    BrowserWindow: { getAllWindows: () => [] },
    ipcMain: { handle: () => {} }
  }
})

const SAMPLE_TLS: TlsScopeSettings = {
  caCertificates: [{ id: 'ca-x', file: 'corp-3f2a.pem', label: 'Corp Root' }],
  clientCertificates: [
    {
      id: 'cc-y',
      host: '*.example.com',
      port: null,
      type: 'pem',
      certFile: 'client-7b1e.crt',
      keyFile: 'client-7b1e.key',
      passphrase: '{{stagingPass}}',
      disabled: false
    }
  ]
}

describe('appsettings backward compatibility for tls field', () => {
  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(join(tmpdir(), 'fp-tls-store-app-'))
  })
  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true })
  })

  it('loads a pre-existing settings file with no tls field', async () => {
    const file = join(userDataDir, 'appsettings.json')
    await fs.writeFile(
      file,
      JSON.stringify({
        zoomFactor: 1,
        language: 'en',
        requestTimeoutSeconds: 30,
        proxy: { enabled: false, url: '', username: '', password: '' },
        updates: { intervalDays: 15, lastCheckAt: null, autoCheckEnabled: true }
      })
    )

    vi.resetModules()
    const mod = await import('../ipc/appsettings.ipc')
    const settings = mod.readAppSettings()
    expect(settings.tls).toBeUndefined()
  })

  it('round-trips the tls field through writeAppSettings → readAppSettings', async () => {
    vi.resetModules()
    const mod = await import('../ipc/appsettings.ipc')
    mod.writeAppSettings({ tls: SAMPLE_TLS })

    const fresh: AppSettings = mod.readAppSettings()
    expect(fresh.tls).toEqual(SAMPLE_TLS)
  })

  it('preserves an existing tls field when writing an unrelated patch', async () => {
    vi.resetModules()
    const mod = await import('../ipc/appsettings.ipc')
    mod.writeAppSettings({ tls: SAMPLE_TLS })
    mod.writeAppSettings({ zoomFactor: 1.25 })

    const fresh = mod.readAppSettings()
    expect(fresh.tls).toEqual(SAMPLE_TLS)
    expect(fresh.zoomFactor).toBe(1.25)
  })
})

describe('workspace settings backward compatibility for tls field', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await fs.mkdtemp(join(tmpdir(), 'fp-tls-store-ws-'))
    await fs.mkdir(join(workspace, '.fetchpier'), { recursive: true })
    // Isolate the adapter's per-process cache between tests. This replaces the
    // previous vi.resetModules() + dynamic import, which forced an expensive
    // re-transform of @fetchpier/core under coverage and timed out on load.
    clearHttpSettingsCache()
  })
  afterEach(async () => {
    clearHttpSettingsCache()
    await fs.rm(workspace, { recursive: true, force: true })
  })

  it('loads a pre-existing workspace settings file with no tls field', async () => {
    await fs.writeFile(
      join(workspace, '.fetchpier/settings.json'),
      JSON.stringify({
        version: 1,
        http: {
          httpVersion: 'auto',
          verifySsl: true,
          followRedirects: true,
          maxRedirects: 10,
          followAuthorizationOnRedirect: false,
          encodeUrl: true,
          disableCookieJar: false
        }
      })
    )

    const settings = await loadHttpSettings(workspace)
    expect(settings.tls).toBeUndefined()
  })

  it('round-trips the tls field through updateHttpSettings → loadHttpSettings', async () => {
    await updateHttpSettings(workspace, { tls: SAMPLE_TLS })
    // Clear the cache so the read comes from disk, not the just-written cache.
    clearHttpSettingsCache()

    const fresh = await loadHttpSettings(workspace)
    expect(fresh.tls).toEqual(SAMPLE_TLS)
  })
})
