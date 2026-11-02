import { ipcMain, dialog } from 'electron'
import { writeFile } from 'fs/promises'
import type { SaveDialogArgs, SaveDialogResult } from '../../shared/types'

const MAX_CONTENT_SIZE = 10_000_000

export function registerFileHandlers(): void {
  ipcMain.handle(
    'file:save-dialog',
    async (_e, args: SaveDialogArgs): Promise<SaveDialogResult> => {
      if (typeof args.content !== 'string' || args.content.length > MAX_CONTENT_SIZE) {
        throw new Error('Content exceeds maximum allowed size (10 MB)')
      }

      const result = await dialog.showSaveDialog({
        defaultPath: args.defaultName,
        filters: args.filters
      })

      if (result.canceled || !result.filePath) {
        return { canceled: true }
      }

      await writeFile(result.filePath, args.content, 'utf-8')
      return { canceled: false, path: result.filePath }
    }
  )
}
