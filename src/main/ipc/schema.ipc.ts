// Schema-import IPC handler.
//
// The schema-import pipeline (`graphql`, `js-yaml` and the importers) is
// **not** loaded at boot. `@fetchpier/core` exposes it
// through the secondary entry point `@fetchpier/core/schema-import`, and this
// handler dynamically `import()`s the module on the first IPC call, caching
// the resulting promise so the second call onward is free (REQ-0063).
//
// Why the cache exists: keeping the static import out of this file is what
// actually removes ~200–300 ms of `readFileSync` + parse time from the main
// process cold path. If you change this file, do NOT hoist the dynamic import
// to top-level and do NOT convert the `import type` below into a value
// import — the ESLint `no-restricted-imports` rule will fail, and the cold
// path optimization vanishes silently.

import { ipcMain, BrowserWindow } from 'electron'
import type { SchemaFormat, SchemaImportRequest, SchemaImportResult } from '../../shared/types'
import { requireActiveWorkspaceHandle } from '../state/active-workspace'

let schemaImportPromise: Promise<typeof import('@fetchpier/core/schema-import')> | null = null

function loadSchemaImport(): Promise<typeof import('@fetchpier/core/schema-import')> {
  if (!schemaImportPromise) {
    schemaImportPromise = import('@fetchpier/core/schema-import')
  }
  return schemaImportPromise
}

export function registerSchemaHandlers(): void {
  ipcMain.handle(
    'schema:detectFormat',
    async (_event, content: string): Promise<SchemaFormat | null> => {
      const { detectFormat } = await loadSchemaImport()
      return detectFormat(content)
    }
  )

  ipcMain.handle(
    'schema:import',
    async (event, request: SchemaImportRequest): Promise<SchemaImportResult> => {
      const { importSchema } = await loadSchemaImport()
      const senderWindow = BrowserWindow.fromWebContents(event.sender) ?? null
      const workspacePath = requireActiveWorkspaceHandle().path
      return importSchema(request, workspacePath, (phase, current, total, message) => {
        if (senderWindow && !senderWindow.isDestroyed()) {
          senderWindow.webContents.send('schema:import:progress', {
            phase,
            current,
            total,
            message
          })
        }
      })
    }
  )
}
