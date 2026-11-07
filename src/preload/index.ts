import { contextBridge, ipcRenderer } from 'electron'
import { RESOLVED_THEME_ARG } from '../shared/app-shell'
import type { MenuItemId } from '../shared/menu-model'
import { boundedWait, HANDLERS_READY_BOUND_MS } from '../shared/bounded-wait'
import { decodePaletteArg } from '../shared/palette/launch-arg'
import type {
  AppearancePalettes,
  AppearanceState,
  Theme,
  HttpRequest,
  HttpResponse,
  WorkspaceTree,
  FsCascadeResult,
  NameCheckInput,
  NameCheckResult,
  FsDeleteResult,
  Environment,
  HistoryEntry,
  HistoryEntryListItem,
  ParsedHttpFile,
  WorkspaceStateView,
  WorkspaceSessionTab,
  WorkspaceOpenStrings,
  OpenPathResult,
  RestoreResult,
  WorkspaceHttpSettings,
  AppSettings,
  ExecutedRequestResult,
  ScriptExecutionResult,
  WindowPlatform,
  UnresponsiveCloseStrings,
  MenuLabels,
  RendererMenuState,
  SaveDialogArgs,
  SaveDialogResult,
  Cookie,
  SchemaFormat,
  SchemaImportRequest,
  SchemaImportResult,
  SchemaImportProgress,
  UpdatesSettings,
  UpdateCheckResponse,
  TlsScope,
  TlsScopeSettings,
  CACertEntry,
  ClientCertEntry,
  ClientCertPreview,
  ActivityPanelPopoutEvent,
  RequestUiState,
  RequestUiStateMap,
  StagedBinaryEntry,
  SecretsStatus,
  SecretsSetupResult,
  SecretsEnterKeyResult,
  SecretsAddKeyResult,
  WorkspaceKeysListing,
  EnvironmentLocalView,
  LicenseText
} from '../shared/types'

/**
 * Apply the theme before the document has any styling.
 *
 * The main process decides the theme before it creates the window and hands it
 * to this process as an argument, so reading it here costs nothing and — the
 * point — never waits on that process, which may be busy loading the rest of
 * the application at exactly this moment. Asking it instead would stall the
 * renderer for the length of that load.
 *
 * The renderer cannot work the theme out for itself: the platform's own
 * colour-scheme signal does not follow the applied theme on this stack
 * (measured), and the content-security policy rules out the usual inline
 * bootstrap script. This file is neither — it is a real script the platform
 * loads at document start, ahead of the stylesheet and ahead of the bundle.
 *
 * Marking `<html>` here is what lets the startup shell, which is pure CSS,
 * paint in the user's theme without any application code having run.
 */
const INITIAL_RESOLVED_THEME: 'light' | 'dark' =
  process.argv
    .find((arg) => arg.startsWith(RESOLVED_THEME_ARG))
    ?.slice(RESOLVED_THEME_ARG.length) === 'dark'
    ? 'dark'
    : 'light'

/**
 * The palette overrides of both modes, handed over the same way and for the
 * same reason as the theme. Decoding is strict — anything but known palette
 * tokens with plain colour values drops the whole argument — so this can only
 * ever carry appearance data. `null` for a mode means the built-in palette.
 */
const INITIAL_PALETTES = decodePaletteArg(process.argv)

function markResolvedTheme(): void {
  const root = document.documentElement
  root.classList.toggle('dark', INITIAL_RESOLVED_THEME === 'dark')
  // Inline custom properties beat both palette blocks of the stylesheet, so the
  // startup shell — which reads the tokens — paints in the user's palette too.
  const tokens = INITIAL_PALETTES[INITIAL_RESOLVED_THEME]
  if (tokens)
    for (const [name, value] of Object.entries(tokens)) root.style.setProperty(`--${name}`, value)
}

// `<html>` does not exist yet when this runs — measured, in every launch — so
// this listener is the mechanism, not a fallback. It fires when parsing reaches
// `interactive`, about 3 ms later and still ~100 ms before the first paint.
document.addEventListener('readystatechange', markResolvedTheme, { once: true })

/**
 * The readiness gate.
 *
 * The main process creates the window before it loads most of what serves the
 * interface, so an operation can be requested before anything is listening for
 * it. Holding each one until registration completes makes that race impossible
 * rather than merely unlikely, and it lives here — in the one place all 119
 * operations already pass through — so the interface is unaware of it.
 *
 * `app:handlersReady` is asked for with the raw channel on purpose: gating the
 * gate on itself would deadlock.
 */
const handlersReady = boundedWait(
  ipcRenderer.invoke('app:handlersReady'),
  HANDLERS_READY_BOUND_MS,
  () =>
    console.error(
      `[preload] The main process did not report its handlers ready within ` +
        `${HANDLERS_READY_BOUND_MS} ms. Proceeding; operations will fail until it does.`
    )
)

/**
 * Every operation waits for the gate. After startup this is an already-settled
 * promise, so the cost is one microtask.
 *
 * Returns `any` to mirror the channel call it wraps: each caller below declares
 * the concrete result type, exactly as it did when calling the channel directly.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function invoke(channel: string, ...args: unknown[]): Promise<any> {
  await handlersReady
  return ipcRenderer.invoke(channel, ...args)
}

const api = {
  // ── App Settings ─────────────────────────────────────────────────────────
  appSettings: {
    get: (): Promise<AppSettings> => invoke('appSettings:get'),
    set: (partial: Partial<AppSettings>): Promise<AppSettings> =>
      invoke('appSettings:set', partial),
    getUpdates: (): Promise<UpdatesSettings> => invoke('appSettings:getUpdates'),
    setUpdates: (partial: Partial<UpdatesSettings>): Promise<UpdatesSettings> =>
      invoke('appSettings:setUpdates', partial)
  },

  // ── Updates ──────────────────────────────────────────────────────────────
  updates: {
    check: (): Promise<UpdateCheckResponse> => invoke('updates:check')
  },

  // ── Locale ───────────────────────────────────────────────────────────────
  locale: {
    get: (): Promise<string> => invoke('locale:get')
  },

  // ── Theme ─────────────────────────────────────────────────────────────────
  theme: {
    /**
     * The theme already in force for this window, resolved by the main process
     * before the window was created. Available synchronously because the first
     * frame — the startup shell — cannot wait for a promise.
     */
    initialResolved: INITIAL_RESOLVED_THEME,
    getSystemIsDark: (): Promise<boolean> => invoke('theme:getSystemIsDark'),
    setNativeTheme: (theme: Theme): Promise<void> => invoke('theme:setNativeTheme', theme),
    onSystemChanged: (callback: (isDark: boolean) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, isDark: boolean): void => callback(isDark)
      ipcRenderer.on('theme:systemChanged', handler)
      return () => ipcRenderer.removeListener('theme:systemChanged', handler)
    }
  },

  // ── Appearance (color palettes) ─────────────────────────────────────────
  appearance: {
    /** The palettes in force when this window was created, both modes. Synchronous, like the theme. */
    initial: INITIAL_PALETTES,
    get: (): Promise<AppearanceState> => invoke('appearance:get'),
    set: (prefs: AppearancePalettes): Promise<AppearanceState> => invoke('appearance:set', prefs),
    onChanged: (callback: (state: AppearanceState) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, state: AppearanceState): void =>
        callback(state)
      ipcRenderer.on('appearance:changed', handler)
      return () => ipcRenderer.removeListener('appearance:changed', handler)
    }
  },

  // ── Workspace ─────────────────────────────────────────────────────────────
  workspace: {
    open: (strings: WorkspaceOpenStrings): Promise<string | null> =>
      invoke('workspace:open', strings),
    create: (strings: WorkspaceOpenStrings): Promise<string | null> =>
      invoke('workspace:create', strings),
    getLast: (): Promise<RestoreResult> => invoke('workspace:getLast'),
    getRecent: (): Promise<string[]> => invoke('workspace:getRecent'),
    openPath: (workspacePath: string): Promise<OpenPathResult> =>
      invoke('workspace:openPath', workspacePath),
    // Releases the workspace in this process too: session handle, folder
    // watcher and the per-workspace caches. Without it "close" was a
    // renderer-local reset and the watcher kept running on the closed folder
    // (REQ menu coherence §6.7).
    close: (): Promise<void> => invoke('workspace:close'),
    getHttpSettings: (): Promise<WorkspaceHttpSettings> => invoke('workspace:getHttpSettings'),
    updateHttpSettings: (partial: Partial<WorkspaceHttpSettings>): Promise<WorkspaceHttpSettings> =>
      invoke('workspace:updateHttpSettings', partial),
    getRequestsRoot: (): Promise<string> => invoke('workspace:getRequestsRoot'),
    onHttpSettingsChanged: (callback: (settings: WorkspaceHttpSettings) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, settings: WorkspaceHttpSettings): void =>
        callback(settings)
      ipcRenderer.on('workspace:httpSettingsChanged', handler)
      return () => ipcRenderer.removeListener('workspace:httpSettingsChanged', handler)
    },
    onGitignoreGenerated: (
      callback: (payload: { workspacePath: string }) => void
    ): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, payload: { workspacePath: string }): void =>
        callback(payload)
      ipcRenderer.on('workspace:gitignoreGenerated', handler)
      return () => ipcRenderer.removeListener('workspace:gitignoreGenerated', handler)
    }
  },

  // ── Filesystem ────────────────────────────────────────────────────────────
  filesystem: {
    readTree: (): Promise<WorkspaceTree[]> => invoke('filesystem:readTree'),
    writeFile: (filePath: string, content: string): Promise<void> =>
      invoke('filesystem:writeFile', filePath, content),
    fileExists: (filePath: string): Promise<boolean> => invoke('filesystem:fileExists', filePath),
    findAvailableUntitledPath: (startN: number): Promise<{ filePath: string; name: string }> =>
      invoke('filesystem:findAvailableUntitledPath', startN),
    onChange: (callback: (tree: WorkspaceTree[]) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, tree: WorkspaceTree[]): void => callback(tree)
      ipcRenderer.on('filesystem:changed', handler)
      return () => ipcRenderer.removeListener('filesystem:changed', handler)
    },
    onFileChanged: (callback: (filePath: string) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, filePath: string): void => callback(filePath)
      ipcRenderer.on('filesystem:fileChanged', handler)
      return () => ipcRenderer.removeListener('filesystem:fileChanged', handler)
    },
    /** Automatic file tracking stopped and could not be re-established (REQ-0113 §6.4). */
    onWatchDegraded: (callback: (payload: { workspacePath: string }) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, payload: { workspacePath: string }): void =>
        callback(payload)
      ipcRenderer.on('filesystem:watchDegraded', handler)
      return () => ipcRenderer.removeListener('filesystem:watchDegraded', handler)
    },
    createCollection: (parentPath: string, name: string): Promise<void> =>
      invoke('fs:createCollection', parentPath, name),
    createRequest: (parentPath: string, name: string): Promise<string> =>
      invoke('fs:createRequest', parentPath, name),
    createInstance: (parentPath: string, instanceName: string): Promise<string> =>
      invoke('fs:createInstance', parentPath, instanceName),
    rename: (oldPath: string, newName: string): Promise<FsCascadeResult> =>
      invoke('fs:rename', oldPath, newName),
    delete: (targetPath: string): Promise<FsDeleteResult> => invoke('fs:delete', targetPath),
    move: (sourcePath: string, targetFolder: string): Promise<FsCascadeResult> =>
      invoke('fs:move', sourcePath, targetFolder),
    duplicate: (filePath: string): Promise<string> => invoke('fs:duplicate', filePath),
    duplicateInstance: (sourcePath: string, instanceName: string): Promise<string> =>
      invoke('fs:duplicateInstance', sourcePath, instanceName),
    checkName: (input: NameCheckInput): Promise<NameCheckResult> => invoke('fs:checkName', input)
  },

  // ── OS shell ──────────────────────────────────────────────────────────────
  shell: {
    /** Reveal an absolute, in-workspace path in the OS file manager. */
    revealPath: (absPath: string): Promise<void> => invoke('shell:revealPath', absPath)
  },

  // ── HTTP Request ──────────────────────────────────────────────────────────
  request: {
    send: (request: HttpRequest, executionId?: string): Promise<ExecutedRequestResult> =>
      invoke('http:send', request, executionId),
    cancel: (executionId: string): Promise<boolean> => invoke('http:cancel', executionId),
    parseFile: (filePath: string): Promise<ParsedHttpFile> => invoke('http:parseFile', filePath)
  },

  // ── Scripts ───────────────────────────────────────────────────────────────
  scripts: {
    executePreRequest: (args: {
      script: string
      request: HttpRequest
      environment?: Record<string, string>
      variables?: Record<string, unknown>
    }): Promise<ScriptExecutionResult> => invoke('script:execute-pre-request', args),
    executePostResponse: (args: {
      script: string
      request: HttpRequest
      response: HttpResponse
      environment?: Record<string, string>
      variables?: Record<string, unknown>
    }): Promise<ScriptExecutionResult> => invoke('script:execute-post-response', args)
  },

  // ── Environments ──────────────────────────────────────────────────────────
  environment: {
    list: (): Promise<Environment[]> => invoke('env:list'),
    read: (envPath: string): Promise<Environment> => invoke('env:read', envPath),
    save: (env: Environment, baseline?: Record<string, string | null>): Promise<void> =>
      invoke('env:save', env, baseline),
    create: (name: string): Promise<Environment> => invoke('env:create', name),
    rename: (envId: string, newName: string): Promise<Environment> =>
      invoke('env:rename', envId, newName),
    duplicate: (sourceEnvId: string, newName: string): Promise<Environment> =>
      invoke('env:duplicate', sourceEnvId, newName),
    delete: (envId: string): Promise<void> => invoke('env:delete', envId)
  },

  // ── Secrets (REQ-0070) ────────────────────────────────────────────────────
  secrets: {
    status: (): Promise<SecretsStatus> => invoke('secrets:status'),
    setup: (): Promise<SecretsSetupResult> => invoke('secrets:setup'),
    enterKey: (key: string): Promise<SecretsEnterKeyResult> => invoke('secrets:enterKey', key),
    reveal: (envId: string, name: string): Promise<string> => invoke('secrets:reveal', envId, name),
    setSecret: (envId: string, name: string, plaintext: string): Promise<Environment> =>
      invoke('secrets:setSecret', envId, name, plaintext),
    unsetSecret: (envId: string, name: string): Promise<Environment> =>
      invoke('secrets:unsetSecret', envId, name),
    clearSecret: (envId: string, name: string): Promise<Environment> =>
      invoke('secrets:clearSecret', envId, name),
    // REQ-0077 — delete a secret directly (both layers, no decryption).
    deleteSecret: (envId: string, name: string): Promise<Environment> =>
      invoke('secrets:deleteSecret', envId, name),
    rotate: (): Promise<SecretsSetupResult> => invoke('secrets:rotate'),
    // REQ-0073 — Workspace keys management (metadata only).
    listKeys: (): Promise<WorkspaceKeysListing> => invoke('secrets:listKeys'),
    deleteKey: (keyId: string): Promise<void> => invoke('secrets:deleteKey', keyId),
    addKey: (key: string, hint?: string, replace?: boolean): Promise<SecretsAddKeyResult> =>
      invoke('secrets:addKey', key, hint, replace)
  },

  // ── Local value layer (REQ-0074) ──────────────────────────────────────────
  localValues: {
    getView: (envId: string): Promise<EnvironmentLocalView> => invoke('localvalues:getView', envId),
    set: (envId: string, name: string, value: string): Promise<void> =>
      invoke('localvalues:set', envId, name, value),
    clear: (envId: string, name: string): Promise<void> => invoke('localvalues:clear', envId, name),
    seed: (envId: string, name: string): Promise<void> => invoke('localvalues:seed', envId, name),
    reveal: (envId: string, name: string): Promise<string> =>
      invoke('localvalues:reveal', envId, name),
    onChanged: (
      callback: (payload: {
        environmentId: string
        orphanNotice?: { environmentId: string; variables: string[] }
      }) => void
    ): (() => void) => {
      const handler = (
        _: Electron.IpcRendererEvent,
        payload: {
          environmentId: string
          orphanNotice?: { environmentId: string; variables: string[] }
        }
      ): void => callback(payload)
      ipcRenderer.on('localValues:changed', handler)
      return () => ipcRenderer.removeListener('localValues:changed', handler)
    }
  },

  // ── Window ────────────────────────────────────────────────────────────────
  window: {
    setTitle: (title: string): Promise<void> => invoke('window:setTitle', title),
    closeConfirmed: (): Promise<void> => invoke('window:close-confirmed'),
    minimize: (): Promise<void> => invoke('window:minimize'),
    maximizeToggle: (): Promise<void> => invoke('window:maximize-toggle'),
    close: (): Promise<void> => invoke('window:close'),
    isMaximized: (): Promise<boolean> => invoke('window:is-maximized'),
    // Fire-and-forget push of the translated close-fallback dialog strings
    // (REQ-0104). Sent on i18n init and on every language change so main
    // always has a current snapshot ready if a close request is never
    // acknowledged — see UnresponsiveCloseStrings.
    setCloseDialogStrings: (strings: UnresponsiveCloseStrings): void =>
      ipcRenderer.send('window:setCloseDialogStrings', strings),
    // Sent immediately on receiving `window:before-close`, before running the
    // unsaved-tabs guard (REQ-0104). Proves the renderer's JS event loop is
    // alive so the close-fallback timeout bounds acknowledgment, not the
    // user's Save/Discard/Cancel decision.
    sendCloseAck: (): void => ipcRenderer.send('window:close-ack'),
    // Sender-scoped controls — act on the calling renderer's own window (used by
    // the Activity Panel popout titlebar). See window-controls.ipc.ts.
    selfMinimize: (): Promise<void> => invoke('window:self-minimize'),
    selfMaximizeToggle: (): Promise<void> => invoke('window:self-maximize-toggle'),
    selfClose: (): Promise<void> => invoke('window:self-close'),
    selfIsMaximized: (): Promise<boolean> => invoke('window:self-is-maximized'),
    getPlatform: (): Promise<WindowPlatform> => invoke('window:get-platform'),
    onMaximizedChanged: (callback: (isMaximized: boolean) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, isMaximized: boolean): void =>
        callback(isMaximized)
      ipcRenderer.on('window:maximized-changed', handler)
      return () => ipcRenderer.removeListener('window:maximized-changed', handler)
    },
    onFocusChanged: (callback: (isFocused: boolean) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, isFocused: boolean): void =>
        callback(isFocused)
      ipcRenderer.on('window:focus-changed', handler)
      return () => ipcRenderer.removeListener('window:focus-changed', handler)
    },
    onBeforeClose: (callback: () => void): (() => void) => {
      const handler = (): void => callback()
      ipcRenderer.on('window:before-close', handler)
      return () => ipcRenderer.removeListener('window:before-close', handler)
    }
  },

  // ── Menu events ───────────────────────────────────────────────────────────
  menu: {
    on: (callback: (action: MenuItemId) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, action: MenuItemId): void => callback(action)
      ipcRenderer.on('menu:action', handler)
      return () => ipcRenderer.removeListener('menu:action', handler)
    },
    // Fire-and-forget, like the close-dialog strings: main caches the latest
    // snapshot. The first one also ends the menu's inert starting state
    // (REQ menu coherence §6.3, §6.6).
    setLabels: (labels: MenuLabels): void => ipcRenderer.send('menu:setLabels', labels),
    setState: (patch: RendererMenuState): void => ipcRenderer.send('menu:setState', patch)
  },

  // ── Display / Zoom ────────────────────────────────────────────────────────
  display: {
    getScaleFactor: (): Promise<number> => invoke('display:getScaleFactor'),
    getZoom: (): Promise<number> => invoke('display:getZoom'),
    setZoom: (factor: number): Promise<number> => invoke('display:setZoom', factor),
    onScaleChanged: (cb: (factor: number) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, factor: number): void => cb(factor)
      ipcRenderer.on('display:scaleChanged', handler)
      return () => ipcRenderer.removeListener('display:scaleChanged', handler)
    },
    onZoomChanged: (cb: (factor: number) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, factor: number): void => cb(factor)
      ipcRenderer.on('display:zoomChanged', handler)
      return () => ipcRenderer.removeListener('display:zoomChanged', handler)
    }
  },

  // ── File dialogs ──────────────────────────────────────────────────────────
  file: {
    saveDialog: (args: SaveDialogArgs): Promise<SaveDialogResult> =>
      invoke('file:save-dialog', args)
  },

  // ── Certificates (TLS material) ──────────────────────────────────────────
  certificates: {
    list: (scope: TlsScope): Promise<TlsScopeSettings> => invoke('certificates:list', scope),
    addCA: (args: { scope: TlsScope; sourcePath: string; label?: string }): Promise<CACertEntry> =>
      invoke('certificates:addCA', args),
    addClient: (args: {
      scope: TlsScope
      host: string
      port?: number | null
      type: 'pem' | 'pfx'
      sourcePaths: { certPath?: string; keyPath?: string; pfxPath?: string }
      passphrase?: string | null
    }): Promise<ClientCertEntry> => invoke('certificates:addClient', args),
    updateCA: (args: {
      scope: TlsScope
      id: string
      patch: { label?: string | null }
    }): Promise<CACertEntry> => invoke('certificates:updateCA', args),
    updateClient: (args: {
      scope: TlsScope
      id: string
      patch: {
        host?: string
        port?: number | null
        passphrase?: string | null
        disabled?: boolean
      }
    }): Promise<ClientCertEntry> => invoke('certificates:updateClient', args),
    remove: (args: {
      scope: TlsScope
      id: string
      kind: 'ca' | 'client'
    }): Promise<{ removed: true }> => invoke('certificates:remove', args),
    previewForRequest: (args: { url: string }): Promise<ClientCertPreview> =>
      invoke('certificates:previewForRequest', args),
    pickSourceFile: (args: { kind: 'ca' | 'pemCert' | 'pemKey' | 'pfx' }): Promise<string | null> =>
      invoke('certificates:pickSourceFile', args),
    onChanged: (callback: (scope: TlsScope) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, scope: TlsScope): void => callback(scope)
      ipcRenderer.on('certificates:changed', handler)
      return () => ipcRenderer.removeListener('certificates:changed', handler)
    }
  },

  // ── Cookies ───────────────────────────────────────────────────────────────
  cookies: {
    setActiveEnvironment: (envId: string | null): Promise<void> =>
      invoke('cookies:setActiveEnvironment', envId),
    list: (envId: string): Promise<Cookie[]> => invoke('cookies:list', envId),
    create: (
      envId: string,
      cookie: Omit<Cookie, 'id' | 'createdAt' | 'updatedAt'>
    ): Promise<Cookie> => invoke('cookies:create', envId, cookie),
    update: (envId: string, cookieId: string, changes: Partial<Cookie>): Promise<Cookie> =>
      invoke('cookies:update', envId, cookieId, changes),
    delete: (envId: string, cookieId: string): Promise<void> =>
      invoke('cookies:delete', envId, cookieId),
    clear: (envId: string): Promise<void> => invoke('cookies:clear', envId),
    deleteJar: (envId: string): Promise<void> => invoke('cookies:deleteJar', envId),
    onChanged: (callback: (envId: string) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, envId: string): void => callback(envId)
      ipcRenderer.on('cookies:changed', handler)
      return () => ipcRenderer.removeListener('cookies:changed', handler)
    }
  },

  // ── Schema import ─────────────────────────────────────────────────────────
  schema: {
    detectFormat: (content: string): Promise<SchemaFormat | null> =>
      invoke('schema:detectFormat', content),
    import: (request: SchemaImportRequest): Promise<SchemaImportResult> =>
      invoke('schema:import', request),
    onProgress: (callback: (progress: SchemaImportProgress) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, progress: SchemaImportProgress): void =>
        callback(progress)
      ipcRenderer.on('schema:import:progress', handler)
      return () => ipcRenderer.removeListener('schema:import:progress', handler)
    }
  },

  // ── App info ──────────────────────────────────────────────────────────────
  app: {
    getVersion: (): Promise<string> => invoke('app:getVersion'),
    getThirdPartyLicenses: (): Promise<string> => invoke('app:getThirdPartyLicenses'),
    getLicense: (): Promise<LicenseText> => invoke('app:getLicense'),
    openExternal: (url: string): void => ipcRenderer.send('app:openExternal', url)
  },

  // ── Activity Panel ────────────────────────────────────────────────────────
  activityPanel: {
    popout: (): Promise<{ ok: true } | { ok: false; reason: string }> =>
      invoke('activityPanel:popout'),
    dock: (): Promise<{ ok: true }> => invoke('activityPanel:dock'),
    focusPopout: (): Promise<boolean> => invoke('activityPanel:focusPopout'),
    isPoppedOut: (): Promise<boolean> => invoke('activityPanel:isPoppedOut'),
    onPopoutChanged: (callback: (event: ActivityPanelPopoutEvent) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, payload: ActivityPanelPopoutEvent): void =>
        callback(payload)
      ipcRenderer.on('activity-panel:popout-changed', handler)
      return () => ipcRenderer.removeListener('activity-panel:popout-changed', handler)
    }
  },

  // ── UI State (per-request UI persistence) ────────────────────────────────
  uiState: {
    read: (requestId: string): Promise<RequestUiState | null> => invoke('ui-state:read', requestId),
    readAll: (): Promise<RequestUiStateMap> => invoke('ui-state:readAll'),
    write: (requestId: string, state: RequestUiState): Promise<RequestUiState | null> =>
      invoke('ui-state:write', requestId, state),
    delete: (requestId: string): Promise<void> => invoke('ui-state:delete', requestId),
    onChanged: (
      callback: (payload: { requestId: string; state: RequestUiState | null }) => void
    ): (() => void) => {
      const handler = (
        _: Electron.IpcRendererEvent,
        payload: { requestId: string; state: RequestUiState | null }
      ): void => callback(payload)
      ipcRenderer.on('ui-state:changed', handler)
      return () => ipcRenderer.removeListener('ui-state:changed', handler)
    }
  },

  // ── Tree State (collection-tree expansion persistence) ───────────────────
  treeState: {
    read: (): Promise<string[] | null> => invoke('tree-state:read'),
    write: (paths: string[]): Promise<void> => invoke('tree-state:write', paths)
  },

  // ── Workspace State (tab session + workspace prefs persistence) ──────────
  workspaceState: {
    read: (): Promise<WorkspaceStateView> => invoke('workspace-state:read'),
    setSession: (session: { tabs: WorkspaceSessionTab[]; activeTabIndex: number }): Promise<void> =>
      invoke('workspace-state:setSession', session),
    setActiveEnvironment: (id: string | null): Promise<void> =>
      invoke('workspace-state:setActiveEnvironment', id)
  },

  // ── Binary (single-file binary body uploads, REQ-0065) ───────────────────
  binary: {
    selectAndStage: (args?: {
      sourcePath?: string
      confirmed?: boolean
    }): Promise<
      | { status: 'cancelled' }
      | { status: 'blocked'; sizeBytes: number; blockBytes: number; sourcePath: string }
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
    > => invoke('binary:selectAndStage', args),
    stat: (args: {
      ref: string
    }): Promise<{ exists: boolean; sizeBytes?: number; mimeType?: string }> =>
      invoke('binary:stat', args),
    remove: (args: { ref: string }): Promise<{ removed: boolean }> => invoke('binary:remove', args),
    list: (): Promise<StagedBinaryEntry[]> => invoke('binary:list')
  },

  // ── History ───────────────────────────────────────────────────────────────
  history: {
    save: (entry: HistoryEntry): Promise<void> => invoke('history:save', entry),
    list: (filter?: { requestId?: string; limit?: number }): Promise<HistoryEntryListItem[]> =>
      invoke('history:list', filter),
    /** Returns the raw `.http` text for one entry. Consumers rebuild the
     * in-memory `HistoryEntry` via `activityLogToHistoryEntry` from
     * `src/shared/lib/activity-log`. */
    get: (entryId: string): Promise<string> => invoke('history:get', entryId),
    delete: (entryId: string): Promise<void> => invoke('history:delete', entryId),
    clear: (): Promise<void> => invoke('history:clear'),
    updateSourceFile: (oldRelPath: string, newRelPath: string, isFolder: boolean): Promise<void> =>
      invoke('history:updateSourceFile', oldRelPath, newRelPath, isFolder),
    countForPath: (relPath: string, isFolder: boolean): Promise<number> =>
      invoke('history:countForPath', relPath, isFolder),
    deleteForPath: (relPath: string, isFolder: boolean): Promise<void> =>
      invoke('history:deleteForPath', relPath, isFolder)
  }
}

// `api` is the only bridge on the main world. This used to also expose
// `@electron-toolkit/preload`'s `electronAPI` as `window.electron` — raw
// `ipcRenderer.send/invoke/on` over *any* channel plus a `process.env` getter,
// sitting next to the typed surface and contradicting the rule that the
// renderer never sees a raw channel name. Nothing consumed it;
// it was never even declared in `src/renderer/env.d.ts`. `test/e2e/sandbox.spec.ts`
// (SEC-001) asserts `window.electron` stays `undefined`.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-expect-error (define in dts)
  window.api = api
}
