import { app, BrowserWindow, ipcMain } from 'electron'
import { requests, CoreError, describeError } from '@fetchpier/core'
import { readAppSettings } from './appsettings.ipc'
import type {
  EnvironmentChanges,
  HttpRequest,
  ParsedHttpFile,
  ExecutedRequestResult,
  WorkspaceHttpSettings
} from '../../shared/types'
import { desktopUserAgent } from '../../shared/types'
import { resolveFindingsSettings } from '../../shared/lib/findings'
import { getCachedHttpSettings, loadHttpSettings } from '../config/workspace-settings-store'
import { DEFAULT_WORKSPACE_HTTP_SETTINGS } from '../config/defaults'
import { requireActiveWorkspaceHandle } from '../state/active-workspace'
import { resolveTlsForUrl } from '../tls/store'
import { lockAllSecrets } from '../secrets/service'
import { getWorkspaceKey } from '../secrets/keystore'
import { normalizeLocalLayer } from '../secrets/local-values'

/** Replace the values of secret-named entries with their log mask. */
function maskChanges(
  changes: EnvironmentChanges | undefined,
  secretNames: ReadonlySet<string>
): EnvironmentChanges | undefined {
  if (!changes) return changes
  return {
    set: Object.fromEntries(
      Object.entries(changes.set).map(([k, v]) => [k, secretNames.has(k) ? `{secret:${k}}` : v])
    ),
    removed: changes.removed
  }
}

/**
 * The send result as the renderer may see it: environment changes a script wrote
 * under a secret name carry `{secret:<name>}`, never the value (the engine already
 * masked the script output itself).
 */
function maskSecretEnvironmentChanges(
  result: ExecutedRequestResult,
  secretNames: string[]
): ExecutedRequestResult {
  if (secretNames.length === 0) return result
  const names = new Set(secretNames)
  const section = <T extends { environmentChanges?: EnvironmentChanges }>(s: T | undefined) =>
    s ? { ...s, environmentChanges: maskChanges(s.environmentChanges, names) } : s
  return {
    ...result,
    environmentChanges: maskChanges(result.environmentChanges, names),
    ...(result.scriptResults
      ? {
          scriptResults: {
            ...(result.scriptResults.preRequest
              ? { preRequest: section(result.scriptResults.preRequest) }
              : {}),
            ...(result.scriptResults.postResponse
              ? { postResponse: section(result.scriptResults.postResponse) }
              : {})
          }
        }
      : {})
  }
}

let activeEnvironmentId: string | null = null

export function setActiveEnvironmentForCookies(envId: string | null): void {
  activeEnvironmentId = envId
}

function broadcastCookiesChanged(envId: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('cookies:changed', envId)
    }
  }
}

/**
 * REQ-0074: notify open editors that an environment's local value layer changed
 * (a script write persisted, or an orphan cleanup ran). Mirrors `cookies:changed`.
 */
function broadcastLocalValuesChanged(
  envId: string,
  orphanNotice?: { environmentId: string; variables: string[] }
): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('localValues:changed', { environmentId: envId, orphanNotice })
    }
  }
}

let activeWorkspacePath: string | null = null

export function setActiveWorkspaceForHttp(workspacePath: string | null): void {
  // REQ-0070: switching/closing the workspace locks secrets (drops live keys,
  // resets the reveal grace window). The persistent keystore re-unlocks lazily.
  if (workspacePath !== activeWorkspacePath) lockAllSecrets()
  activeWorkspacePath = workspacePath
  if (workspacePath) {
    // Prime the cache so http:send stays synchronous-friendly.
    loadHttpSettings(workspacePath).catch((err) =>
      console.error('[request.ipc] failed to prime http settings cache:', err)
    )
  }
}

async function getResolvedWorkspaceSettings(): Promise<WorkspaceHttpSettings> {
  if (!activeWorkspacePath) return { ...DEFAULT_WORKSPACE_HTTP_SETTINGS }
  const cached = getCachedHttpSettings(activeWorkspacePath)
  if (cached) return cached
  return loadHttpSettings(activeWorkspacePath)
}

/**
 * Registry of in-flight HTTP sends keyed by an opaque execution id supplied
 * by the renderer. Used by `http:cancel` to abort a specific send without
 * affecting other concurrent requests.
 */
const inFlightControllers = new Map<string, AbortController>()

export function registerRequestHandlers(): void {
  ipcMain.handle(
    'http:send',
    async (_event, request: HttpRequest, executionId?: string): Promise<ExecutedRequestResult> => {
      const workspaceSettings = await getResolvedWorkspaceSettings()
      const { requestTimeoutSeconds, proxy, hideSecretsInResponses } = readAppSettings()

      const abortController = new AbortController()
      if (executionId) inFlightControllers.set(executionId, abortController)
      // The abort reason lets the engine report "timed out after N s" rather than
      // a cancellation the user never asked for.
      const timeoutMs = requestTimeoutSeconds * 1000
      const timeoutId = setTimeout(
        () => abortController.abort(requests.timeoutAbortReason(timeoutMs)),
        timeoutMs
      )

      let effectiveRequest = request
      let workspacePathForCore: string | undefined
      if (activeWorkspacePath) workspacePathForCore = activeWorkspacePath
      // Binary bodies are the engine's: it reads the staged file from the
      // workspace, derives Content-Type, and refuses a missing file before
      // anything goes out — the same path the command line uses.
      if (request.bodyType === 'binary' && request.binaryFile?.ref) {
        workspacePathForCore = requireActiveWorkspaceHandle().path
      }

      // REQ-0066 multipart: validate that every file part's staged file
      // exists on disk before handing off to core, so a missing file surfaces
      // a clean MULTIPART_FILE_MISSING here instead of mid-encode. Core also
      // re-checks and throws the same code; this just gives the renderer a
      // faster, more targeted error.
      if (request.bodyType === 'multipart-form' && request.multipartParts) {
        try {
          const handle = requireActiveWorkspaceHandle()
          workspacePathForCore = handle.path
          for (const part of request.multipartParts) {
            if (part.disabled) continue
            if (part.kind !== 'file') continue
            const stat = await handle.binary.stat(part.file.ref)
            if (!stat.exists) {
              clearTimeout(timeoutId)
              if (executionId) inFlightControllers.delete(executionId)
              return {
                error: `Multipart file part "${part.name}" references missing file: ${part.file.ref}`
              }
            }
          }
        } catch (err) {
          clearTimeout(timeoutId)
          if (executionId) inFlightControllers.delete(executionId)
          const message = err instanceof Error ? err.message : String(err)
          return { error: message }
        }
      }

      // The core owns the send's variables (CLI readiness — the same session the
      // command line uses): `{{$env.NAME}}` resolution over the variables the
      // renderer sent, the per-machine local layer, the secrets this request
      // references (markers seeded, contractual SECRETS_* failures before the
      // send), and — after the send — the script writes, always persisted to the
      // local layer. Only the lazy re-wrap / orphan cleanup of that layer stays
      // here (it needs the key store's retained old key — declared debt).
      // REQ-0104: every failure here deregisters the execution.
      let session: requests.VariableSession | undefined
      let prepared: requests.PreparedSend | undefined
      let localOrphanNotice: { environmentId: string; variables: string[] } | undefined
      if (workspacePathForCore) {
        try {
          if (activeEnvironmentId) {
            try {
              localOrphanNotice = await normalizeLocalLayer(
                workspacePathForCore,
                activeEnvironmentId
              )
            } catch (err) {
              // Degrades to the layer as it is on disk: the merge treats a
              // stale entry as an orphan, so resolution falls back to shared.
              console.error('[request.ipc] local value layer normalization failed:', err)
            }
          }
          const handle = requireActiveWorkspaceHandle()
          session = await requests.createVariableSession({
            workspace: handle,
            environmentId: activeEnvironmentId,
            basePlainVariables: effectiveRequest.variables ?? {},
            processEnv: process.env,
            getKey: async () => {
              const keyId = (await handle.secrets.readManifest())?.encryption.keyId
              return keyId ? getWorkspaceKey(keyId) : null
            },
            persistence: 'persist'
          })
          prepared = await session.prepare(effectiveRequest)
          effectiveRequest = prepared.request
        } catch (err) {
          clearTimeout(timeoutId)
          if (executionId) inFlightControllers.delete(executionId)
          const errorCode = err instanceof CoreError ? err.code : undefined
          const message = err instanceof Error ? err.message : String(err)
          return errorCode ? { error: message, errorCode } : { error: message }
        }
      }

      let result: ExecutedRequestResult
      try {
        result = await requests.execute(effectiveRequest, {
          environmentId: activeEnvironmentId,
          workspaceSettings,
          proxy,
          signal: abortController.signal,
          userAgent: desktopUserAgent(app.getVersion()),
          ...(prepared ? { secretNames: prepared.secretNames } : {}),
          // The response as received is asked for only when the user turned off
          // "hide secrets in responses"; `response` stays masked for the log.
          revealResponse: !hideSecretsInResponses,
          // REQ-0089: core owns workspace TLS resolution keyed off the path; the
          // passphrase-secret resolver is bound here so a secret-referencing
          // passphrase decrypts lazily under the unlocked key.
          resolveTls: (url, env, onWarning) =>
            resolveTlsForUrl(url, env, {
              workspacePath: workspacePathForCore ?? null,
              ...(prepared ? { resolvePassphraseSecrets: prepared.resolvePassphraseSecrets } : {}),
              ...(onWarning ? { onWarning } : {})
            }),
          onCookiesCaptured: (envId) => broadcastCookiesChanged(envId),
          workspacePath: workspacePathForCore,
          secrets: prepared?.masker,
          // Passive security findings: the desktop evaluates every send unless
          // the workspace turned it off (`http.findings.enabled`). What is
          // evaluated comes from the same settings, inside the engine.
          evaluateFindings: resolveFindingsSettings(workspaceSettings.findings).enabled
        })
      } catch (err) {
        // The pipeline surfaces request/script failures in-band; a thrown error
        // here is unexpected. `CoreError`'s `code`/`details` do not survive IPC,
        // so re-shape to a plain readable message for the renderer — but keep the
        // `errorCode` (REQ-0089: a locked secret passphrase surfaces the clean
        // SECRETS_KEY_MISSING signal before the handshake, not an opaque error).
        // The reason comes from core, never from `.message` here: a failure
        // whose own message is empty (every address of a multi-address host
        // refused) rendered as no error at all, because the renderer shows its
        // error state only for a non-empty reason.
        const errorCode = err instanceof CoreError ? err.code : undefined
        return { error: describeError(err), errorCode }
      } finally {
        clearTimeout(timeoutId)
        if (executionId) inFlightControllers.delete(executionId)
      }

      // Advisories known before the send (an undefined `{{$env.*}}` behind a used
      // variable) travel with the result like the engine's own.
      if (prepared && prepared.warnings.length > 0) {
        result = { ...result, warnings: [...prepared.warnings, ...(result.warnings ?? [])] }
      }

      // REQ-0074: persist script-written environment changes to the LOCAL layer
      // (`localvalues.json`), never the shared `config.json` — now through the
      // core's single writer. A write that cannot be persisted (no key) is an
      // advisory on the result, not a log line. Broadcast so an open editor
      // refreshes its Local column.
      if (session && activeEnvironmentId) {
        if (result.environmentChanges) {
          try {
            const notPersisted = await session.apply(result.environmentChanges)
            if (notPersisted.length > 0) {
              result = { ...result, warnings: [...(result.warnings ?? []), ...notPersisted] }
            }
            broadcastLocalValuesChanged(activeEnvironmentId, localOrphanNotice)
          } catch (err) {
            console.error('[request.ipc] failed to persist local env changes:', err)
          }
        } else if (localOrphanNotice) {
          broadcastLocalValuesChanged(activeEnvironmentId, localOrphanNotice)
        }
      }

      // The renderer never receives secret plaintext in bulk (§5 renderer
      // containment): a value a script wrote under a secret name leaves main
      // masked. The session already consumed the plaintext above. The one
      // documented exception is the response as received, and only when the user
      // turned off "hide secrets in responses" — enforced here, whatever the
      // engine returned.
      if (hideSecretsInResponses && result.unmaskedResponse !== undefined) {
        const { unmaskedResponse: _hidden, ...rest } = result
        result = rest
      }
      return prepared ? maskSecretEnvironmentChanges(result, prepared.secretNames) : result
    }
  )

  /**
   * http:cancel — aborts an in-flight send identified by `executionId`.
   * Returns `true` if a matching controller was found and aborted, `false` otherwise
   * (e.g. the send already finished or never registered).
   */
  ipcMain.handle('http:cancel', (_event, executionId: string): boolean => {
    if (typeof executionId !== 'string' || !executionId) return false
    const controller = inFlightControllers.get(executionId)
    if (!controller) return false
    controller.abort()
    return true
  })

  /**
   * http:parseFile — reads a .http file from disk and returns all parsed
   * requests plus the list of variables referenced in the file.
   *
   * Path is confined to the active workspace and must end in `.http`.
   */
  ipcMain.handle('http:parseFile', async (_event, filePath: string): Promise<ParsedHttpFile> => {
    if (!filePath.endsWith('.http')) {
      throw new Error('http:parseFile only accepts .http files')
    }
    const content = await requireActiveWorkspaceHandle().readTextFile(filePath)
    return requests.parseHttpFile(content)
  })
}
