import { tls as coreTls, requests, workspace } from '@fetchpier/core'
import type {
  AppSettings,
  ClientCertPreview,
  TlsScopeSettings,
  WorkspaceHttpSettings
} from '../../shared/types'
import { getActiveWorkspaceHandle } from '../state/active-workspace'
import { getSendEnvironmentId } from '../state/send-environment'
import { readAppSettings, writeAppSettings } from '../ipc/appsettings.ipc'
import { updateHttpSettings } from '../config/workspace-settings-store'
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
  // Feeds a read-modify-write of the block, so it always comes from disk: a
  // cached copy would overwrite an entry a teammate added (git pull).
  readWorkspaceTls: async (ws) => (await workspace.openWorkspace(ws).settings.load()).tls,
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
    /** Material that could not be applied — becomes a send advisory. */
    onWarning?: (reason: string) => void
  }
): Promise<coreTls.ResolvedTlsMaterial> {
  return coreTls.resolveRequestTls(url, environment, {
    workspacePath: ctx.workspacePath,
    appGlobal: buildAppGlobalTls(),
    resolvePassphraseSecrets: ctx.resolvePassphraseSecrets,
    ...(ctx.onWarning ? { onWarning: ctx.onWarning } : {})
  })
}

/**
 * The plain variables a send from the active environment resolves against:
 * shared plain values (with `{{$env.NAME}}`) under the per-machine local layer,
 * layered by the same variable session the send uses. Secrets are left out —
 * the preview never decrypts — so a reference to one stays unresolved.
 */
async function activePlainVariables(): Promise<Record<string, string>> {
  const handle = getActiveWorkspaceHandle()
  if (!handle) return {}
  try {
    const varSession = await requests.createVariableSession({
      workspace: handle,
      // The send's environment, not workspace-state's persisted selection: the
      // two differ when the renderer falls back to an environment it never saved.
      environmentId: getSendEnvironmentId(),
      processEnv: process.env,
      getKey: async () => null,
      persistence: 'memory'
    })
    // A request that references nothing: no secret is resolved, and the
    // prepared variables are exactly the layered plain values.
    const prepared = await varSession.prepare({ method: 'GET', url: '', headers: {} })
    return prepared.request.variables ?? {}
  } catch (err) {
    console.warn('[tls.store] preview could not read the environment:', err)
    return {}
  }
}

/** Scheme + authority of an absolute URL: what certificate matching depends on. */
const URL_HEAD = /^[^:/?#]*:\/\/[^/?#]*/

/**
 * Renderer-facing per-request preview (metadata only; works with the workspace
 * locked). `url` is the request URL as the editor holds it: it is resolved here
 * against the active environment's plain values and given the scheme the client
 * adds, as the send does. When a variable is left in the scheme or the host, no
 * certificate can be named and the preview says so (`undetermined`).
 */
export async function previewClientCertForUrl(url: string): Promise<ClientCertPreview> {
  if (url.trim() === '') return { selected: null, scope: null }
  const resolved = requests.normalizeProtocol(
    requests.resolveString(url, await activePlainVariables()).value
  )
  const head = URL_HEAD.exec(resolved)?.[0] ?? resolved
  if (head.includes('{{')) return { selected: null, scope: null, undetermined: true }
  return coreTls.previewRequestCert(resolved, {
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
