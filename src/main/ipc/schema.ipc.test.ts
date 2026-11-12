/**
 * The schema-import adapter: a URL source is fetched with the app's transport
 * (IMP-08) — the proxy from app settings, the composed TLS material for the
 * active workspace, and the workspace's HTTP settings.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SchemaImportRequest } from '../../shared/types'

type Handler = (event: unknown, ...args: unknown[]) => unknown

const ipcHandlers = new Map<string, Handler>()

vi.mock('electron', () => ({
  app: { getVersion: () => '9.8.7' },
  ipcMain: {
    handle: (channel: string, fn: Handler) => ipcHandlers.set(channel, fn)
  },
  BrowserWindow: { fromWebContents: () => null }
}))

const PROXY = { enabled: true, url: 'http://proxy.example.com:3128', username: '', password: '' }
vi.mock('./appsettings.ipc', () => ({
  readAppSettings: () => ({ proxy: PROXY })
}))

const SETTINGS = { verifySsl: false, httpVersion: 'http1', followRedirects: false }
const { loadHttpSettings } = vi.hoisted(() => ({ loadHttpSettings: vi.fn() }))
vi.mock('../config/workspace-settings-store', () => ({ loadHttpSettings }))

const { resolveTlsForUrl } = vi.hoisted(() => ({ resolveTlsForUrl: vi.fn() }))
vi.mock('../tls/store', () => ({ resolveTlsForUrl }))

vi.mock('../state/active-workspace', () => ({
  requireActiveWorkspaceHandle: () => ({ path: '/fake/workspace' })
}))

const { importSchema } = vi.hoisted(() => ({ importSchema: vi.fn() }))
vi.mock('@fetchpier/core/schema-import', () => ({ importSchema, detectFormat: vi.fn() }))

const REQUEST: SchemaImportRequest = {
  source: { kind: 'url', value: 'https://schemas.example.com/openapi.json' },
  format: 'auto',
  targetFolder: '/fake/workspace/requests',
  collectionName: 'remote',
  conflictStrategy: 'abort'
}

beforeEach(async () => {
  ipcHandlers.clear()
  vi.clearAllMocks()
  loadHttpSettings.mockResolvedValue(SETTINGS)
  importSchema.mockResolvedValue({ operationsCreated: 1 })
  const { registerSchemaHandlers } = await import('./schema.ipc')
  registerSchemaHandlers()
})

describe('schema:import — transport for a URL source (IMP-08)', () => {
  it('passes the app proxy, the workspace settings and the desktop User-Agent', async () => {
    await ipcHandlers.get('schema:import')!({ sender: {} }, REQUEST)

    expect(loadHttpSettings).toHaveBeenCalledWith('/fake/workspace')
    const [req, workspacePath, , options] = importSchema.mock.calls[0]
    expect(req).toEqual(REQUEST)
    expect(workspacePath).toBe('/fake/workspace')
    expect(options.transport).toMatchObject({
      proxy: PROXY,
      settings: SETTINGS,
      userAgent: 'Fetchpier/9.8.7'
    })
  })

  it('resolves the CA bundle per URL against the active workspace', async () => {
    const material = { ca: [Buffer.from('ca')] }
    resolveTlsForUrl.mockResolvedValue(material)
    await ipcHandlers.get('schema:import')!({ sender: {} }, REQUEST)

    const { tls } = importSchema.mock.calls[0][3].transport
    await expect(tls('https://other.example.com/x')).resolves.toEqual(material)
    expect(resolveTlsForUrl).toHaveBeenCalledWith(
      'https://other.example.com/x',
      {},
      { workspacePath: '/fake/workspace' }
    )
  })

  // The import has no environment to resolve a `{{…}}` passphrase against, so a
  // matched client certificate would be handed to TLS with a literal passphrase
  // and break an import that needs no mTLS: only the CA bundle is used.
  it('never presents a client certificate', async () => {
    resolveTlsForUrl.mockResolvedValue({
      ca: [Buffer.from('ca')],
      pfx: Buffer.from('PFX'),
      passphrase: '{{certPass}}'
    })
    await ipcHandlers.get('schema:import')!({ sender: {} }, REQUEST)

    const { tls } = importSchema.mock.calls[0][3].transport
    await expect(tls('https://api.team.example.com/openapi.json')).resolves.toEqual({
      ca: [Buffer.from('ca')]
    })
  })
})
