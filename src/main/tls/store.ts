import { tls as coreTls } from '@fetchpier/core'
import type {
  AppSettings,
  ClientCertPreview,
  TlsScopeSettings,
  WorkspaceHttpSettings
} from '../../shared/types'
import { getActiveWorkspaceHandle } from '../state/active-workspace'
import { readAppSettings, writeAppSettings } from '../ipc/appsettings.ipc'
import {
  getCachedHttpSettings,
  loadHttpSettings,
  updateHttpSettings
} from '../config/workspace-settings-store'
import { appCertsDir } from './paths'

// The certificate *store* (CRUD) lives in `@fetchpier/core/tls`. This adapter
// wires the host collaborators it needs: the app-global cert dir (Electron
// `app.getPath`), the active-workspace singleton, and the app/workspace settings
// persistence layers (which carry the renderer broadcast + per-session cache —
// the relocation of that cache into core is deferred debt, REQ-0089 §2.2).
const store = coreTls.createTlsStore({
  appCertsDir,
  getWorkspacePath: () => getActiveWorkspaceHandle()?.path ?? null,
  readAppTls: () => readAppSettings().tls,
  writeAppTls: (next) => writeAppSettings({ tls: next } as Partial<AppSettings>).tls,
  readWorkspaceTls: async (ws) => {
    const cached = getCachedHttpSettings(ws)
    if (cached && cached.tls) return cached.tls
    const settings = await loadHttpSettings(ws)
    return settings.tls
  },
  writeWorkspaceTls: async (ws, next) => {
    const updated = await updateHttpSettings(ws, {
      tls: next
    } as Partial<WorkspaceHttpSettings>)
    return updated.tls
  }
})

const EMPTY_TLS: TlsScopeSettings = { caCertificates: [], clientCertificates: [] }

// REQ-0089: send-time TLS resolution is path-keyed and owned by core. The
// desktop supplies the one input core cannot derive — app-global material, which
// lives in per-user app data — and lets core read all workspace content from the
// workspace path.
function buildAppGlobalTls(): coreTls.AppGlobalTlsMaterial {
  return { certsDir: appCertsDir(), settings: readAppSettings().tls ?? EMPTY_TLS }
}

/**
 * Compose TLS material for an outgoing request. `workspacePath` is the active
 * workspace (the caller already resolved it); `resolvePassphraseSecrets` decrypts
 * a workspace-scope secret passphrase under the unlocked key (bound by the caller).
 */
export function resolveTlsForUrl(
  url: string,
  environment: Record<string, string>,
  ctx: {
    workspacePath: string | null
    resolvePassphraseSecrets?: (names: string[]) => Promise<Record<string, string>>
  }
): Promise<coreTls.ResolvedTlsMaterial> {
  return coreTls.resolveRequestTls(url, environment, {
    workspacePath: ctx.workspacePath,
    appGlobal: buildAppGlobalTls(),
    resolvePassphraseSecrets: ctx.resolvePassphraseSecrets
  })
}

/** Renderer-facing per-request preview (metadata only; works with the workspace locked). */
export function previewClientCertForUrl(url: string): Promise<ClientCertPreview> {
  return coreTls.previewRequestCert(url, {
    workspacePath: getActiveWorkspaceHandle()?.path ?? null,
    appGlobal: buildAppGlobalTls()
  })
}

// All store methods are plain closures (no `this`), so unbinding is safe.
export const loadScopeSettings = store.loadScopeSettings
export const addCA = store.addCA
export const addClient = store.addClient
export const updateCA = store.updateCA
export const updateClient = store.updateClient
export const remove = store.remove

export type ResolvedTlsMaterial = coreTls.ResolvedTlsMaterial
export type AddCAArgs = coreTls.AddCAArgs
export type AddClientArgs = coreTls.AddClientArgs
export type UpdateCAArgs = coreTls.UpdateCAArgs
export type UpdateClientArgs = coreTls.UpdateClientArgs
export type RemoveArgs = coreTls.RemoveArgs
