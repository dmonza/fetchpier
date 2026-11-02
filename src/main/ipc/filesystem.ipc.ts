import { ipcMain } from 'electron'
import type {
  WorkspaceTree,
  FsCascadeResult,
  FsDeleteResult,
  NameCheckInput,
  NameCheckResult
} from '../../shared/types'
import { requireActiveWorkspaceHandle } from '../state/active-workspace'

// Thin adapter (REQ Core-owned workspace handle, F6): every workspace operation —
// the tree read, file existence/write, and the create/rename/move/delete/duplicate
// mutations with their name-conflict + `*.instance.http` cascade rules — lives in
// `@fetchpier/core` behind the handle. Conflict tokens (`*_CONFLICT`,
// `MOVE_INTO_SELF`, `INSTANCE_*`) are raised by the core and mapped to i18n by the
// renderer; they pass through unchanged.

export function registerFilesystemHandlers(): void {
  ipcMain.handle('filesystem:readTree', async (): Promise<WorkspaceTree[]> => {
    return requireActiveWorkspaceHandle().tree.read()
  })

  ipcMain.handle(
    'filesystem:writeFile',
    async (_event, filePath: string, content: string): Promise<void> => {
      await requireActiveWorkspaceHandle().atomicWrite(filePath, content)
    }
  )

  ipcMain.handle('filesystem:fileExists', async (_event, filePath: string): Promise<boolean> => {
    return requireActiveWorkspaceHandle().fileExists(filePath)
  })

  ipcMain.handle(
    'filesystem:findAvailableUntitledPath',
    async (_event, startN: number): Promise<{ filePath: string; name: string }> => {
      return requireActiveWorkspaceHandle().tree.findAvailableUntitled(startN)
    }
  )

  ipcMain.handle(
    'fs:createCollection',
    async (_event, parentPath: string, name: string): Promise<void> => {
      await requireActiveWorkspaceHandle().tree.createCollection(parentPath, name)
    }
  )

  ipcMain.handle(
    'fs:createRequest',
    async (_event, parentPath: string, name: string): Promise<string> => {
      return requireActiveWorkspaceHandle().tree.createRequest(parentPath, name)
    }
  )

  ipcMain.handle(
    'fs:createInstance',
    async (_event, parentPath: string, instanceName: string): Promise<string> => {
      return requireActiveWorkspaceHandle().tree.createInstance(parentPath, instanceName)
    }
  )

  ipcMain.handle(
    'fs:rename',
    async (_event, oldPath: string, newName: string): Promise<FsCascadeResult> => {
      return requireActiveWorkspaceHandle().tree.rename(oldPath, newName)
    }
  )

  ipcMain.handle('fs:delete', async (_event, targetPath: string): Promise<FsDeleteResult> => {
    return requireActiveWorkspaceHandle().tree.delete(targetPath)
  })

  ipcMain.handle(
    'fs:move',
    async (_event, sourcePath: string, targetFolder: string): Promise<FsCascadeResult> => {
      return requireActiveWorkspaceHandle().tree.move(sourcePath, targetFolder)
    }
  )

  ipcMain.handle('fs:duplicate', async (_event, filePath: string): Promise<string> => {
    return requireActiveWorkspaceHandle().tree.duplicate(filePath)
  })

  ipcMain.handle(
    'fs:duplicateInstance',
    async (_event, sourcePath: string, instanceName: string): Promise<string> => {
      return requireActiveWorkspaceHandle().tree.duplicateInstance(sourcePath, instanceName)
    }
  )

  // Read-only name-availability verdict for the sidebar's inline validation
  // (REQ case-insensitive tree name uniqueness §5.5). Answers, never throws
  // on a collision; the mutating handlers above stay the gate.
  ipcMain.handle(
    'fs:checkName',
    async (_event, input: NameCheckInput): Promise<NameCheckResult> => {
      return requireActiveWorkspaceHandle().tree.checkName(input)
    }
  )
}
