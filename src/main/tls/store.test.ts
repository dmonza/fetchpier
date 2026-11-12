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

// The adapter (`./store`) reads the active workspace and the active environment
// from these two main-process singletons; the tests below point them at a temp
// workspace. Both modules are imported dynamically, after `userDataDir` is set,
// and from the same module graph as the settings store they observe.
const session = vi.hoisted(() => ({
  workspacePath: null as string | null,
  environmentId: null as string | null
}))

vi.mock('../state/active-workspace', async () => {
  const { workspace } = await import('@fetchpier/core')
  const handle = (): ReturnType<typeof workspace.openWorkspace> | null =>
    session.workspacePath ? workspace.openWorkspace(session.workspacePath) : null
  return {
    getActiveWorkspaceHandle: handle,
    requireActiveWorkspaceHandle: () => {
      const h = handle()
      if (!h) throw new Error('No active workspace')
      return h
    }
  }
})

// The persisted selection is left empty on purpose: a fresh workspace (or clone)
// shows and sends from an environment it never persisted, so the preview must
// read the environment the send uses, not workspace-state's (TLS-03 review).
vi.mock('../state/workspace-state-store', () => ({
  getView: () => ({
    activeEnvironmentId: null,
    session: { tabs: [], activeTabIndex: -1 }
  })
}))

vi.mock('../state/send-environment', () => ({
  getSendEnvironmentId: () => session.environmentId,
  setSendEnvironmentId: (id: string | null) => {
    session.environmentId = id
  }
}))

async function writeWorkspaceSettings(ws: string, http: Record<string, unknown>): Promise<void> {
  await fs.writeFile(
    join(ws, '.fetchpier/settings.json'),
    JSON.stringify({ version: 1, http }, null, 2)
  )
}

async function loadAdapter(): Promise<{
  tls: typeof import('./store')
  settings: typeof import('../config/workspace-settings-store')
}> {
  return {
    tls: await import('./store'),
    settings: await import('../config/workspace-settings-store')
  }
}

// TLS-01 — `.fetchpier/settings.json` travels with the team through Git, so the
// file can change under a running desktop. The session cache must not hide that
// change, and a TLS mutation must never rebuild the block from a stale copy.
describe('workspace HTTP settings follow external edits', () => {
  let ws: string

  beforeEach(async () => {
    ws = await fs.mkdtemp(join(tmpdir(), 'fp-tls-ext-'))
    userDataDir = ws
    await fs.mkdir(join(ws, '.fetchpier/certs'), { recursive: true })
    await writeWorkspaceSettings(ws, {
      verifySsl: false,
      tls: { caCertificates: [], clientCertificates: [] }
    })
    session.workspacePath = ws
    session.environmentId = null
    clearHttpSettingsCache()
  })
  afterEach(async () => {
    const { settings } = await loadAdapter()
    settings.clearHttpSettingsCache()
    clearHttpSettingsCache()
    session.workspacePath = null
    await fs.rm(ws, { recursive: true, force: true })
  })

  const teammateEdit = async (): Promise<void> => {
    await writeWorkspaceSettings(ws, {
      verifySsl: true,
      tls: { caCertificates: [{ id: 'ca-team', file: 'ca-team.pem' }], clientCertificates: [] }
    })
    await fs.writeFile(join(ws, '.fetchpier/certs/ca-team.pem'), 'team')
  }

  it('reads the file as it is now after it changed on disk', async () => {
    const { settings } = await loadAdapter()
    expect((await settings.loadHttpSettings(ws)).verifySsl).toBe(false)
    await teammateEdit()

    expect((await settings.loadHttpSettings(ws)).verifySsl).toBe(true)
    expect(settings.getCachedHttpSettings(ws)?.verifySsl).toBe(true)
  })

  it('keeps serving the cached object while the file is unchanged', async () => {
    const { settings } = await loadAdapter()
    const first = await settings.loadHttpSettings(ws)
    expect(await settings.loadHttpSettings(ws)).toBe(first)
    expect(settings.getCachedHttpSettings(ws)).toBe(first)
  })

  it('reports a cache miss as null so callers load from disk', async () => {
    const { settings } = await loadAdapter()
    settings.clearHttpSettingsCache()
    expect(settings.getCachedHttpSettings(ws)).toBeNull()
    expect(settings.getCachedHttpSettings(null)).toBeNull()
    await settings.loadHttpSettings(ws)
    expect(settings.getCachedHttpSettings(join(ws, 'other'))).toBeNull()
  })

  it('a certificate edit keeps the entry a teammate added on disk', async () => {
    const { tls, settings } = await loadAdapter()
    await settings.loadHttpSettings(ws) // primes the cache with the empty block
    await teammateEdit()

    await tls.updateCA({ scope: 'workspace', id: 'ca-team', patch: { label: 'Team root' } })

    const onDisk = JSON.parse(await fs.readFile(join(ws, '.fetchpier/settings.json'), 'utf-8'))
    expect(onDisk.http.tls.caCertificates).toEqual([
      { id: 'ca-team', file: 'ca-team.pem', label: 'Team root' }
    ])
    expect(onDisk.http.verifySsl).toBe(true)
  })
})

// TLS-03 — the preview gets the URL as the editor holds it and resolves it in
// main against the active environment's plain values, as the send does.
describe('previewClientCertForUrl — variable-based URLs', () => {
  let ws: string

  beforeEach(async () => {
    ws = await fs.mkdtemp(join(tmpdir(), 'fp-tls-preview-'))
    userDataDir = ws
    await fs.mkdir(join(ws, '.fetchpier/certs'), { recursive: true })
    await writeWorkspaceSettings(ws, {
      tls: {
        caCertificates: [],
        clientCertificates: [
          {
            id: 'cc-api',
            host: 'api.example.com',
            port: null,
            type: 'pfx',
            pfxFile: 'client-api.pfx',
            passphrase: null,
            disabled: false
          }
        ]
      }
    })
    await fs.writeFile(join(ws, '.fetchpier/certs/client-api.pfx'), 'PFX')
    await fs.mkdir(join(ws, 'environments/dev'), { recursive: true })
    await fs.writeFile(
      join(ws, 'environments/dev/config.json'),
      JSON.stringify({
        id: 'env-dev',
        name: 'dev',
        variables: {
          baseUrl: 'https://api.example.com',
          apiHost: 'api.example.com',
          secretHost: null
        }
      })
    )
    session.workspacePath = ws
    session.environmentId = 'env-dev'
    clearHttpSettingsCache()
  })
  afterEach(async () => {
    session.workspacePath = null
    session.environmentId = null
    await fs.rm(ws, { recursive: true, force: true })
  })

  it.each([
    ['a base URL variable', '{{baseUrl}}/users'],
    ['a host variable with no scheme (sent over https)', '{{apiHost}}/users'],
    ['a literal URL whose path holds an unknown variable', 'https://api.example.com/{{nope}}']
  ])('previews the certificate the send presents for %s', async (_label, url) => {
    const { tls } = await loadAdapter()
    const preview = await tls.previewClientCertForUrl(url)
    expect(preview.selected?.id).toBe('cc-api')
    expect(preview.scope).toBe('workspace')
    expect(preview.undetermined).toBeUndefined()
  })

  it.each([
    ['an unknown base URL variable', '{{nope}}/users'],
    ['an unknown host variable after the scheme', 'https://{{nope}}/users'],
    ['an unknown scheme variable', '{{scheme}}://api.example.com/users'],
    ['a host held in a secret', 'https://{{secretHost}}/users']
  ])('cannot determine the certificate for %s', async (_label, url) => {
    const { tls } = await loadAdapter()
    const preview = await tls.previewClientCertForUrl(url)
    expect(preview).toEqual({ selected: null, scope: null, undetermined: true })
  })

  it('cannot determine a variable-based host when no environment is active', async () => {
    session.environmentId = null
    const { tls } = await loadAdapter()
    expect((await tls.previewClientCertForUrl('{{baseUrl}}/users')).undetermined).toBe(true)
  })

  it('reports no certificate for a host no entry matches', async () => {
    const { tls } = await loadAdapter()
    expect(await tls.previewClientCertForUrl('https://other.example.com/x')).toEqual({
      selected: null,
      scope: null
    })
  })
})
