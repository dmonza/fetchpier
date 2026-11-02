import { ipcMain } from 'electron'
import type {
  Environment,
  EnvironmentLocalView,
  SecretsAddKeyResult,
  SecretsEnterKeyResult,
  SecretsSetupResult,
  SecretsStatus,
  WorkspaceKeysListing
} from '../../shared/types'
import { requireActiveWorkspaceHandle } from '../state/active-workspace'
import { assertSafeIdentifier } from '../fs/safe-path'
import * as service from '../secrets/service'
import * as localValues from '../secrets/local-values'

/**
 * REQ-0070 — secrets domain IPC. Thin adapters over `../secrets/service`.
 * Every handler validates its inputs; plaintext crosses the boundary only
 * through `secrets:reveal`, one value at a time, behind the re-auth gate.
 */
export function registerSecretsHandlers(): void {
  ipcMain.handle('secrets:status', async (): Promise<SecretsStatus> => {
    return service.getStatus(requireActiveWorkspaceHandle().path)
  })

  ipcMain.handle('secrets:setup', async (): Promise<SecretsSetupResult> => {
    return service.setupKey(requireActiveWorkspaceHandle().path)
  })

  ipcMain.handle('secrets:enterKey', async (_e, key: unknown): Promise<SecretsEnterKeyResult> => {
    if (typeof key !== 'string') throw new Error('secrets:enterKey — key must be a string')
    return service.enterKey(requireActiveWorkspaceHandle().path, key)
  })

  ipcMain.handle('secrets:reveal', async (_e, envId: string, name: string): Promise<string> => {
    assertSafeIdentifier(envId, 'environment id')
    if (typeof name !== 'string' || !name) throw new Error('secrets:reveal — name required')
    return service.revealValue(requireActiveWorkspaceHandle().path, envId, name)
  })

  ipcMain.handle(
    'secrets:setSecret',
    async (_e, envId: string, name: string, plaintext: string): Promise<Environment> => {
      assertSafeIdentifier(envId, 'environment id')
      if (typeof name !== 'string' || !name) throw new Error('secrets:setSecret — name required')
      if (typeof plaintext !== 'string') throw new Error('secrets:setSecret — plaintext required')
      return service.setSecret(requireActiveWorkspaceHandle().path, envId, name, plaintext)
    }
  )

  ipcMain.handle(
    'secrets:unsetSecret',
    async (_e, envId: string, name: string): Promise<Environment> => {
      assertSafeIdentifier(envId, 'environment id')
      if (typeof name !== 'string' || !name) throw new Error('secrets:unsetSecret — name required')
      return service.unsetSecret(requireActiveWorkspaceHandle().path, envId, name)
    }
  )

  ipcMain.handle(
    'secrets:clearSecret',
    async (_e, envId: string, name: string): Promise<Environment> => {
      assertSafeIdentifier(envId, 'environment id')
      if (typeof name !== 'string' || !name) throw new Error('secrets:clearSecret — name required')
      return service.clearSecret(requireActiveWorkspaceHandle().path, envId, name)
    }
  )

  ipcMain.handle(
    'secrets:deleteSecret',
    async (_e, envId: string, name: string): Promise<Environment> => {
      assertSafeIdentifier(envId, 'environment id')
      if (typeof name !== 'string' || !name) throw new Error('secrets:deleteSecret — name required')
      return service.deleteSecret(requireActiveWorkspaceHandle().path, envId, name)
    }
  )

  ipcMain.handle('secrets:rotate', async (): Promise<SecretsSetupResult> => {
    return service.rotateKey(requireActiveWorkspaceHandle().path)
  })

  // REQ-0073 — Workspace keys management. These operate on the machine-local
  // keystore and deliberately do NOT require an active workspace (a key may be
  // added before its workspace is cloned). Metadata only crosses the boundary.
  ipcMain.handle('secrets:listKeys', async (): Promise<WorkspaceKeysListing> => {
    return service.listKeys()
  })

  ipcMain.handle('secrets:deleteKey', async (_e, keyId: unknown): Promise<void> => {
    if (typeof keyId !== 'string' || !/^[0-9a-f]{16}$/.test(keyId)) {
      throw new Error('secrets:deleteKey — keyId must be 16 hex chars')
    }
    await service.deleteKey(keyId)
  })

  ipcMain.handle(
    'secrets:addKey',
    async (_e, key: unknown, hint: unknown, replace: unknown): Promise<SecretsAddKeyResult> => {
      if (typeof key !== 'string') throw new Error('secrets:addKey — key must be a string')
      if (hint !== undefined && typeof hint !== 'string') {
        throw new Error('secrets:addKey — hint must be a string')
      }
      if (replace !== undefined && typeof replace !== 'boolean') {
        throw new Error('secrets:addKey — replace must be a boolean')
      }
      return service.addKey(key, hint, replace)
    }
  )

  // REQ-0074 — local value layer (`environments/<id>/.state/localvalues.json`).
  // Per-machine overrides; the desktop is the only writer (the CLI is read-only).
  ipcMain.handle(
    'localvalues:getView',
    async (_e, envId: string): Promise<EnvironmentLocalView> => {
      assertSafeIdentifier(envId, 'environment id')
      return localValues.getLocalView(requireActiveWorkspaceHandle().path, envId)
    }
  )

  ipcMain.handle(
    'localvalues:set',
    async (_e, envId: string, name: string, value: string): Promise<void> => {
      assertSafeIdentifier(envId, 'environment id')
      if (typeof name !== 'string' || !name) throw new Error('localvalues:set — name required')
      if (typeof value !== 'string') throw new Error('localvalues:set — value must be a string')
      await localValues.setLocalValue(requireActiveWorkspaceHandle().path, envId, name, value)
    }
  )

  ipcMain.handle('localvalues:clear', async (_e, envId: string, name: string): Promise<void> => {
    assertSafeIdentifier(envId, 'environment id')
    if (typeof name !== 'string' || !name) throw new Error('localvalues:clear — name required')
    await localValues.clearLocalValue(requireActiveWorkspaceHandle().path, envId, name)
  })

  // REQ-0075 — seed the local entry with the current shared value (unchecking
  // Sync). The renderer passes only the name; the shared value (incl. secret
  // plaintext) is read and written entirely in main, never crossing the boundary.
  ipcMain.handle('localvalues:seed', async (_e, envId: string, name: string): Promise<void> => {
    assertSafeIdentifier(envId, 'environment id')
    if (typeof name !== 'string' || !name) throw new Error('localvalues:seed — name required')
    await localValues.seedLocalValue(requireActiveWorkspaceHandle().path, envId, name)
  })

  ipcMain.handle('localvalues:reveal', async (_e, envId: string, name: string): Promise<string> => {
    assertSafeIdentifier(envId, 'environment id')
    if (typeof name !== 'string' || !name) throw new Error('localvalues:reveal — name required')
    return localValues.revealLocalValue(requireActiveWorkspaceHandle().path, envId, name)
  })
}
