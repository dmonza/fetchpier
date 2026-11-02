import { BrowserWindow, ipcMain } from 'electron'
import { requests, CoreError, describeError } from '@fetchpier/core'
import { readAppSettings } from './appsettings.ipc'
import type {
  HttpRequest,
  ParsedHttpFile,
  ExecutedRequestResult,
  WorkspaceHttpSettings
} from '../../shared/types'
import { getCachedHttpSettings, loadHttpSettings } from '../config/workspace-settings-store'
import { DEFAULT_WORKSPACE_HTTP_SETTINGS } from '../config/defaults'
import { requireActiveWorkspaceHandle } from '../state/active-workspace'
import { resolveTlsForUrl } from '../tls/store'
import { buildSendMasker, lockAllSecrets, resolvePassphraseSecrets } from '../secrets/service'
import { loadMergedEnvironment, persistScriptEnvChanges } from '../secrets/local-values'

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
      const { requestTimeoutSeconds, proxy } = readAppSettings()

      const abortController = new AbortController()
      if (executionId) inFlightControllers.set(executionId, abortController)
      const timeoutId = setTimeout(() => abortController.abort(), requestTimeoutSeconds * 1000)

      let effectiveRequest = request
      let binaryBody: Buffer | undefined
      let workspacePathForCore: string | undefined
      if (activeWorkspacePath) workspacePathForCore = activeWorkspacePath
      if (request.bodyType === 'binary' && request.binaryFile?.ref) {
        try {
          const handle = requireActiveWorkspaceHandle()
          workspacePathForCore = handle.path
          binaryBody = await handle.binary.read(request.binaryFile.ref)
        } catch (err) {
          clearTimeout(timeoutId)
          if (executionId) inFlightControllers.delete(executionId)
          const message =
            (err as NodeJS.ErrnoException).code === 'ENOENT'
              ? `Binary file not found: ${request.binaryFile.ref}`
              : err instanceof Error
                ? err.message
                : String(err)
          return { error: message }
        }
        const hasContentType = Object.keys(request.headers).some(
          (k) => k.toLowerCase() === 'content-type'
        )
        if (!hasContentType) {
          const ct = request.binaryFile.mimeType || 'application/octet-stream'
          effectiveRequest = {
            ...request,
            headers: { ...request.headers, 'Content-Type': ct },
            // Keep the authoritative ordered list in sync with the record.
            headerList: request.headerList
              ? [...request.headerList, { name: 'Content-Type', value: ct }]
              : undefined
          }
        }
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

      // REQ-0067: resolve `{{$env.NAME}}` references in the environment-supplied
      // variables before they enter the request pipeline. The resolution always
      // produces a string (possibly empty) — see the handle's dotenv.resolveReferences.
      // REQ-0104: guarded like the binary/multipart pre-flight branches above —
      // any failure here must not leave the execution registered forever.
      if (workspacePathForCore && effectiveRequest.variables) {
        try {
          effectiveRequest = {
            ...effectiveRequest,
            variables: await requireActiveWorkspaceHandle().dotenv.resolveReferences(
              effectiveRequest.variables,
              process.env
            )
          }
        } catch (err) {
          clearTimeout(timeoutId)
          if (executionId) inFlightControllers.delete(executionId)
          const message = err instanceof Error ? err.message : String(err)
          return { error: message }
        }
      }

      // REQ-0074: resolve the local value layer (`.state/localvalues.json`). Overlay
      // plain local overrides + local-only names onto the interpolation variables,
      // and use the merged secret map (local encrypted overrides win) for masking.
      // Lazy re-wrap / orphan cleanup run inside loadMergedEnvironment. A failure
      // here degrades to the shared layer rather than blocking the send.
      let mergedSecretsMap: Record<string, string | null> | undefined
      let localOrphanNotice: { environmentId: string; variables: string[] } | undefined
      if (workspacePathForCore && activeEnvironmentId) {
        try {
          const { merged, localPlainOverlay, orphanNotice } = await loadMergedEnvironment(
            workspacePathForCore,
            activeEnvironmentId
          )
          mergedSecretsMap = merged.secretsMap
          localOrphanNotice = orphanNotice
          if (Object.keys(localPlainOverlay).length > 0) {
            effectiveRequest = {
              ...effectiveRequest,
              variables: { ...(effectiveRequest.variables ?? {}), ...localPlainOverlay }
            }
          }
        } catch (err) {
          console.error('[request.ipc] local value layer resolution failed:', err)
        }
      }

      // REQ-0070: resolve the secrets this request references and seed the
      // marker variables. Contractual failures (locked / needs-value / corrupt)
      // surface before the send — no request is emitted.
      let sendMasker: Awaited<ReturnType<typeof buildSendMasker>>
      if (workspacePathForCore) {
        try {
          sendMasker = await buildSendMasker(
            workspacePathForCore,
            activeEnvironmentId,
            effectiveRequest,
            mergedSecretsMap
          )
        } catch (err) {
          clearTimeout(timeoutId)
          if (executionId) inFlightControllers.delete(executionId)
          const errorCode = err instanceof CoreError ? err.code : undefined
          const message = err instanceof Error ? err.message : String(err)
          return { error: message, errorCode }
        }
        if (sendMasker) {
          effectiveRequest = {
            ...effectiveRequest,
            variables: { ...(effectiveRequest.variables ?? {}), ...sendMasker.markerVariables }
          }
        }
      }

      let result: ExecutedRequestResult
      try {
        result = await requests.execute(effectiveRequest, {
          environmentId: activeEnvironmentId,
          workspaceSettings,
          proxy,
          signal: abortController.signal,
          // REQ-0089: core owns workspace TLS resolution keyed off the path; the
          // passphrase-secret resolver is bound here so a secret-referencing
          // passphrase decrypts lazily under the unlocked key.
          resolveTls: (url, env) =>
            resolveTlsForUrl(url, env, {
              workspacePath: workspacePathForCore ?? null,
              resolvePassphraseSecrets: (names) =>
                resolvePassphraseSecrets(
                  workspacePathForCore as string,
                  activeEnvironmentId,
                  names,
                  mergedSecretsMap
                )
            }),
          onCookiesCaptured: (envId) => broadcastCookiesChanged(envId),
          binaryBody,
          workspacePath: workspacePathForCore,
          secrets: sendMasker
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

      // REQ-0074: persist script-written environment changes to the LOCAL layer
      // (`localvalues.json`), never the shared `config.json` (CA-02). The send already
      // completed, so a persistence failure is logged, not surfaced as a request
      // error. Broadcast so an open editor refreshes its Local column.
      if (workspacePathForCore && activeEnvironmentId) {
        if (result.environmentChanges) {
          try {
            await persistScriptEnvChanges(
              workspacePathForCore,
              activeEnvironmentId,
              result.environmentChanges
            )
            broadcastLocalValuesChanged(activeEnvironmentId, localOrphanNotice)
          } catch (err) {
            console.error('[request.ipc] failed to persist local env changes:', err)
          }
        } else if (localOrphanNotice) {
          broadcastLocalValuesChanged(activeEnvironmentId, localOrphanNotice)
        }
      }

      return result
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
