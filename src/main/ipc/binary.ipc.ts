import { dialog, ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { DEFAULT_BINARY_FILE_LIMITS } from '../../shared/types'
import type { BinaryFileLimits, StagedBinaryEntry } from '../../shared/types'
import { getCachedHttpSettings, loadHttpSettings } from '../config/workspace-settings-store'
import { requireActiveWorkspaceHandle } from '../state/active-workspace'

// IPC return shapes
export type BinarySelectAndStageResult =
  | { status: 'cancelled' }
  | {
      status: 'blocked'
      sizeBytes: number
      blockBytes: number
      sourcePath: string
    }
  | {
      status: 'requiresConfirmation'
      sourcePath: string
      sizeBytes: number
      warnBytes: number
      blockBytes: number
    }
  | {
      status: 'staged'
      ref: string
      originalName: string
      sizeBytes: number
      mimeType: string
    }

export interface BinarySelectAndStageArgs {
  /** When set, skips the open dialog (renderer already has the path). */
  sourcePath?: string
  /** When true, bypass the warn threshold (user already saw the confirmation). */
  confirmed?: boolean
}

export interface BinaryStatArgs {
  ref: string
}

export interface BinaryRemoveArgs {
  ref: string
}

async function resolveLimits(workspacePath: string): Promise<BinaryFileLimits> {
  const settings = getCachedHttpSettings(workspacePath) ?? (await loadHttpSettings(workspacePath))
  return settings.binaryFileLimits ?? DEFAULT_BINARY_FILE_LIMITS
}

export function registerBinaryHandlers(): void {
  ipcMain.handle(
    'binary:selectAndStage',
    async (_event, args?: BinarySelectAndStageArgs): Promise<BinarySelectAndStageResult> => {
      const handle = requireActiveWorkspaceHandle()

      let sourcePath = args?.sourcePath
      if (!sourcePath) {
        const picked = await dialog.showOpenDialog({
          properties: ['openFile'],
          title: 'Select a file to upload'
        })
        if (picked.canceled || picked.filePaths.length === 0) {
          return { status: 'cancelled' }
        }
        sourcePath = picked.filePaths[0]
      }

      const stat = await fs.stat(sourcePath)
      const sizeBytes = stat.size
      const limits = await resolveLimits(handle.path)

      if (sizeBytes > limits.blockBytes) {
        return {
          status: 'blocked',
          sizeBytes,
          blockBytes: limits.blockBytes,
          sourcePath
        }
      }

      if (sizeBytes > limits.warnBytes && !args?.confirmed) {
        return {
          status: 'requiresConfirmation',
          sourcePath,
          sizeBytes,
          warnBytes: limits.warnBytes,
          blockBytes: limits.blockBytes
        }
      }

      const staged = await handle.binary.stage(sourcePath)
      return {
        status: 'staged',
        ref: staged.ref,
        originalName: staged.originalName,
        sizeBytes: staged.sizeBytes,
        mimeType: staged.mimeType
      }
    }
  )

  ipcMain.handle('binary:stat', async (_event, args: BinaryStatArgs) => {
    if (!args || typeof args.ref !== 'string') {
      throw new Error('binary:stat requires { ref }')
    }
    return requireActiveWorkspaceHandle().binary.stat(args.ref)
  })

  ipcMain.handle('binary:remove', async (_event, args: BinaryRemoveArgs) => {
    if (!args || typeof args.ref !== 'string') {
      throw new Error('binary:remove requires { ref }')
    }
    const removed = await requireActiveWorkspaceHandle().binary.remove(args.ref)
    return { removed }
  })

  ipcMain.handle('binary:list', async (): Promise<StagedBinaryEntry[]> => {
    return requireActiveWorkspaceHandle().binary.list()
  })
}
