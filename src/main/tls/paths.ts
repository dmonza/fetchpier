import { app } from 'electron'
import { join } from 'node:path'

/**
 * Canonical certificate directory for the app-global scope (under userData).
 * Stays in the adapter — it depends on Electron's `app.getPath`.
 */
export function appCertsDir(): string {
  return join(app.getPath('userData'), 'certs')
}
