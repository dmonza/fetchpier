import { BrowserWindow, dialog, ipcMain } from 'electron'
import type {
  CACertEntry,
  ClientCertEntry,
  ClientCertPreview,
  TlsScope,
  TlsScopeSettings
} from '../../shared/types'
import {
  addCA,
  addClient,
  loadScopeSettings,
  previewClientCertForUrl,
  remove,
  updateCA,
  updateClient,
  type AddCAArgs,
  type AddClientArgs,
  type RemoveArgs,
  type UpdateCAArgs,
  type UpdateClientArgs
} from '../tls/store'

function broadcast(scope: TlsScope): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('certificates:changed', scope)
  }
}

function assertScope(scope: unknown): TlsScope {
  if (scope === 'workspace' || scope === 'app') return scope
  throw new Error(`Invalid TLS scope: ${String(scope)}`)
}

/** Update and remove name one entry: a missing or empty id names none. */
function assertEntryId(id: unknown): string {
  if (typeof id === 'string' && id !== '') return id
  throw new Error('A certificate id is required')
}

const PICK_FILTERS: Record<
  'ca' | 'pemCert' | 'pemKey' | 'pfx',
  { name: string; extensions: string[] }[]
> = {
  ca: [
    { name: 'CA certificates', extensions: ['pem', 'crt', 'cer', 'ca-bundle'] },
    { name: 'All files', extensions: ['*'] }
  ],
  pemCert: [
    { name: 'PEM certificate', extensions: ['pem', 'crt', 'cer'] },
    { name: 'All files', extensions: ['*'] }
  ],
  pemKey: [
    { name: 'PEM private key', extensions: ['key', 'pem'] },
    { name: 'All files', extensions: ['*'] }
  ],
  pfx: [
    { name: 'PKCS#12 bundle', extensions: ['pfx', 'p12'] },
    { name: 'All files', extensions: ['*'] }
  ]
}

export function registerCertificateHandlers(): void {
  ipcMain.handle('certificates:list', async (_e, scope: TlsScope): Promise<TlsScopeSettings> => {
    return loadScopeSettings(assertScope(scope))
  })

  ipcMain.handle('certificates:addCA', async (_e, args: AddCAArgs): Promise<CACertEntry> => {
    const scope = assertScope(args.scope)
    const entry = await addCA({ ...args, scope })
    broadcast(scope)
    return entry
  })

  ipcMain.handle(
    'certificates:addClient',
    async (_e, args: AddClientArgs): Promise<ClientCertEntry> => {
      const scope = assertScope(args.scope)
      const entry = await addClient({ ...args, scope })
      broadcast(scope)
      return entry
    }
  )

  ipcMain.handle('certificates:updateCA', async (_e, args: UpdateCAArgs): Promise<CACertEntry> => {
    const scope = assertScope(args.scope)
    const entry = await updateCA({ ...args, scope, id: assertEntryId(args.id) })
    broadcast(scope)
    return entry
  })

  ipcMain.handle(
    'certificates:updateClient',
    async (_e, args: UpdateClientArgs): Promise<ClientCertEntry> => {
      const scope = assertScope(args.scope)
      const entry = await updateClient({ ...args, scope, id: assertEntryId(args.id) })
      broadcast(scope)
      return entry
    }
  )

  ipcMain.handle(
    'certificates:remove',
    async (_e, args: RemoveArgs): Promise<{ removed: true }> => {
      const scope = assertScope(args.scope)
      if (args.kind !== 'ca' && args.kind !== 'client') {
        throw new Error(`Invalid certificate kind: ${String(args.kind)}`)
      }
      const result = await remove({ ...args, scope, id: assertEntryId(args.id) })
      broadcast(scope)
      return result
    }
  )

  ipcMain.handle(
    'certificates:previewForRequest',
    async (_e, args: { url: string }): Promise<ClientCertPreview> => {
      if (!args || typeof args.url !== 'string') return { selected: null, scope: null }
      return previewClientCertForUrl(args.url)
    }
  )

  ipcMain.handle(
    'certificates:pickSourceFile',
    async (_e, args: { kind: 'ca' | 'pemCert' | 'pemKey' | 'pfx' }): Promise<string | null> => {
      const filters = PICK_FILTERS[args.kind]
      if (!filters) throw new Error(`Invalid pick kind: ${String(args.kind)}`)
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters
      })
      if (result.canceled || result.filePaths.length === 0) return null
      return result.filePaths[0]
    }
  )
}
