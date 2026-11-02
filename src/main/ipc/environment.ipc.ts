import { ipcMain } from 'electron'
import { workspace } from '@fetchpier/core'
import type { Environment } from '../../shared/types'
import { requireActiveWorkspaceHandle } from '../state/active-workspace'

/**
 * Identifiers and names are no longer path segments (the folder is derived and
 * validated in core), so the boundary check here is a shape check: reject a
 * missing or blank argument before it reaches the business layer.
 */
function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
}

export function registerEnvironmentHandlers(): void {
  /** env:list — returns all environments in the workspace */
  ipcMain.handle('env:list', async (): Promise<Environment[]> => {
    return requireActiveWorkspaceHandle().environments.list()
  })

  /** env:read — reads a single environment by its config.json path (must live inside the workspace) */
  ipcMain.handle('env:read', async (_event, envPath: string): Promise<Environment> => {
    if (!envPath.endsWith(workspace.ENV_CONFIG_FILE)) {
      throw new Error('env:read — envPath must point to a config.json file')
    }
    return workspace.readEnvFile(requireActiveWorkspaceHandle().resolveInside(envPath))
  })

  /**
   * env:save — overwrites an existing environment's `config.json`. The renderer
   * only manages plain `variables`; the on-disk secret-shaped entries (`enc:`/`null`)
   * are preserved verbatim, the renderer key order is honored, and the concurrent
   * merge is last-writer-wins per variable against the optional `baseline`. All of
   * this lives in the handle's `environments.save` (REQ-0070/0076/0079/0087) — the
   * handler is a thin delegator.
   */
  ipcMain.handle(
    'env:save',
    async (_event, env: Environment, baseline?: Record<string, string | null>): Promise<void> => {
      await requireActiveWorkspaceHandle().environments.save(env, baseline)
    }
  )

  /**
   * env:create — creates a new environment with the given name. The folder is
   * derived from the name and the identifier is generated; a name that derives to
   * nothing or to a taken folder is rejected before anything is written.
   */
  ipcMain.handle('env:create', async (_event, name: string): Promise<Environment> => {
    assertNonEmptyString(name, 'env:create name')
    return requireActiveWorkspaceHandle().environments.create(name)
  })

  /**
   * env:rename — rename an environment. The folder moves (carrying its `.state/`
   * cookie jar and local values) and the display name is rewritten; the opaque
   * identifier is untouched, so the active-environment selection in the personal
   * workspace state never has to be re-pointed.
   */
  ipcMain.handle(
    'env:rename',
    async (_event, envId: string, newName: string): Promise<Environment> => {
      assertNonEmptyString(envId, 'env:rename envId')
      assertNonEmptyString(newName, 'env:rename newName')
      return requireActiveWorkspaceHandle().environments.rename(envId, newName)
    }
  )

  /**
   * env:duplicate — copy an environment within the workspace. The operation lives
   * in the business layer (`environments.duplicate`) so the CLI and any future
   * consumer inherit it; this handler is a thin delegator.
   *
   * Plain variables and secret values are copied verbatim: same workspace key, and
   * the AEAD associated data is the variable name (not the environment id), so the
   * ciphertext keeps authenticating after the copy. Machine-local state is not
   * copied.
   */
  ipcMain.handle(
    'env:duplicate',
    async (_event, sourceEnvId: string, newName: string): Promise<Environment> => {
      assertNonEmptyString(sourceEnvId, 'env:duplicate sourceEnvId')
      assertNonEmptyString(newName, 'env:duplicate newName')
      return requireActiveWorkspaceHandle().environments.duplicate(sourceEnvId, newName)
    }
  )

  /**
   * env:delete — removes the entire environment folder, including any state
   * (cookies, future per-env caches). No separate cookie cleanup needed.
   */
  ipcMain.handle('env:delete', async (_event, envId: string): Promise<void> => {
    await requireActiveWorkspaceHandle().environments.delete(envId)
  })
}
