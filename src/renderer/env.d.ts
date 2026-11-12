/// <reference types="vite/client" />

import type {
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
  HistoryListFilter,
  ParsedHttpFile,
  WorkspaceStateView,
  WorkspaceSessionTab,
  WorkspaceOpenStrings,
  OpenPathResult,
  RestoreResult,
  AppSettings,
  ExecutedRequestResult,
  ScriptExecutionResult,
  WindowPlatform,
  SaveDialogArgs,
  SaveDialogResult,
  WorkspaceHttpSettings,
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
  UnresponsiveCloseStrings,
  MenuLabels,
  RendererMenuState,
  LicenseText,
  AppearancePalettes,
  AppearanceState,
  ModePalettes
} from '../shared/types'
import type { MenuItemId } from '../shared/menu-model'

declare global {
  interface Window {
    api: {
      appSettings: {
        get: () => Promise<AppSettings>
        set: (partial: Partial<AppSettings>) => Promise<AppSettings>
        getUpdates: () => Promise<UpdatesSettings>
        setUpdates: (partial: Partial<UpdatesSettings>) => Promise<UpdatesSettings>
      }
      updates: {
        check: () => Promise<UpdateCheckResponse>
      }
      locale: {
        get: () => Promise<string>
      }
      theme: {
        /** The theme already in force, resolved by main before this window existed. */
        initialResolved: 'light' | 'dark'
        getSystemIsDark: () => Promise<boolean>
        setNativeTheme: (theme: Theme) => Promise<void>
        onSystemChanged: (callback: (isDark: boolean) => void) => () => void
      }
      appearance: {
        /** Both modes' palette overrides in force when this window was created (`null` = built-in). */
        initial: ModePalettes
        get: () => Promise<AppearanceState>
        /** Persists and broadcasts; rejects when the settings file cannot be written. */
        set: (prefs: AppearancePalettes) => Promise<AppearanceState>
        /** The open workspace's palettes (`inherit` allowed); rejects with no workspace or on a failed write. */
        setWorkspace: (prefs: AppearancePalettes) => Promise<AppearanceState>
        onChanged: (callback: (state: AppearanceState) => void) => () => void
      }
      workspace: {
        open: (strings: WorkspaceOpenStrings) => Promise<string | null>
        create: (strings: WorkspaceOpenStrings) => Promise<string | null>
        getLast: () => Promise<RestoreResult>
        /** Read-only: the workspace main has open now (null if none). Never restores. */
        getActive: () => Promise<string | null>
        getRecent: () => Promise<string[]>
        openPath: (workspacePath: string) => Promise<OpenPathResult>
        close: () => Promise<void>
        getHttpSettings: () => Promise<WorkspaceHttpSettings>
        updateHttpSettings: (
          partial: Partial<WorkspaceHttpSettings>
        ) => Promise<WorkspaceHttpSettings>
        getRequestsRoot: () => Promise<string>
        onHttpSettingsChanged: (callback: (settings: WorkspaceHttpSettings) => void) => () => void
        onGitignoreGenerated: (callback: (payload: { workspacePath: string }) => void) => () => void
        /** Main opened, switched or closed (`null`) its workspace. */
        onActiveChanged: (
          callback: (payload: { workspacePath: string | null }) => void
        ) => () => void
      }
      filesystem: {
        readTree: () => Promise<WorkspaceTree[]>
        writeFile: (filePath: string, content: string) => Promise<void>
        fileExists: (filePath: string) => Promise<boolean>
        findAvailableUntitledPath: (startN: number) => Promise<{ filePath: string; name: string }>
        onChange: (callback: (tree: WorkspaceTree[]) => void) => () => void
        onFileChanged: (callback: (filePath: string) => void) => () => void
        onWatchDegraded: (callback: (payload: { workspacePath: string }) => void) => () => void
        createCollection: (parentPath: string, name: string) => Promise<void>
        createRequest: (parentPath: string, name: string) => Promise<string>
        createInstance: (parentPath: string, instanceName: string) => Promise<string>
        rename: (oldPath: string, newName: string) => Promise<FsCascadeResult>
        delete: (targetPath: string) => Promise<FsDeleteResult>
        move: (sourcePath: string, targetFolder: string) => Promise<FsCascadeResult>
        duplicate: (filePath: string) => Promise<string>
        duplicateInstance: (sourcePath: string, instanceName: string) => Promise<string>
        checkName: (input: NameCheckInput) => Promise<NameCheckResult>
      }
      shell: {
        revealPath: (absPath: string) => Promise<void>
      }
      request: {
        send: (request: HttpRequest, executionId?: string) => Promise<ExecutedRequestResult>
        cancel: (executionId: string) => Promise<boolean>
        parseFile: (filePath: string) => Promise<ParsedHttpFile>
      }
      scripts: {
        executePreRequest: (args: {
          script: string
          request: HttpRequest
          environment?: Record<string, string>
          variables?: Record<string, unknown>
        }) => Promise<ScriptExecutionResult>
        executePostResponse: (args: {
          script: string
          request: HttpRequest
          response: HttpResponse
          environment?: Record<string, string>
          variables?: Record<string, unknown>
        }) => Promise<ScriptExecutionResult>
      }
      environment: {
        list: () => Promise<Environment[]>
        read: (envPath: string) => Promise<Environment>
        save: (env: Environment, baseline?: Record<string, string | null>) => Promise<void>
        create: (name: string) => Promise<Environment>
        rename: (envId: string, newName: string) => Promise<Environment>
        duplicate: (sourceEnvId: string, newName: string) => Promise<Environment>
        delete: (envId: string) => Promise<void>
      }
      secrets: {
        status: () => Promise<SecretsStatus>
        setup: () => Promise<SecretsSetupResult>
        enterKey: (key: string) => Promise<SecretsEnterKeyResult>
        reveal: (envId: string, name: string) => Promise<string>
        setSecret: (envId: string, name: string, plaintext: string) => Promise<Environment>
        unsetSecret: (envId: string, name: string) => Promise<Environment>
        clearSecret: (envId: string, name: string) => Promise<Environment>
        deleteSecret: (envId: string, name: string) => Promise<Environment>
        rotate: () => Promise<SecretsSetupResult>
        listKeys: () => Promise<WorkspaceKeysListing>
        deleteKey: (keyId: string) => Promise<void>
        addKey: (key: string, hint?: string, replace?: boolean) => Promise<SecretsAddKeyResult>
      }
      localValues: {
        getView: (envId: string) => Promise<EnvironmentLocalView>
        set: (envId: string, name: string, value: string) => Promise<void>
        clear: (envId: string, name: string) => Promise<void>
        seed: (envId: string, name: string) => Promise<void>
        reveal: (envId: string, name: string) => Promise<string>
        onChanged: (
          callback: (payload: {
            environmentId: string
            orphanNotice?: { environmentId: string; variables: string[] }
          }) => void
        ) => () => void
      }
      window: {
        setTitle: (title: string) => Promise<void>
        closeConfirmed: () => Promise<void>
        minimize: () => Promise<void>
        maximizeToggle: () => Promise<void>
        close: () => Promise<void>
        isMaximized: () => Promise<boolean>
        selfMinimize: () => Promise<void>
        selfMaximizeToggle: () => Promise<void>
        selfClose: () => Promise<void>
        selfIsMaximized: () => Promise<boolean>
        getPlatform: () => Promise<WindowPlatform>
        onMaximizedChanged: (callback: (isMaximized: boolean) => void) => () => void
        onFocusChanged: (callback: (isFocused: boolean) => void) => () => void
        onBeforeClose: (callback: () => void) => () => void
        setCloseDialogStrings: (strings: UnresponsiveCloseStrings) => void
        sendCloseAck: () => void
      }
      menu: {
        on: (callback: (action: MenuItemId) => void) => () => void
        /**
         * Push the translated menu vocabulary. Also the readiness signal — the
         * menu stays inert until the first push lands (REQ menu coherence §6.3).
         */
        setLabels: (labels: MenuLabels) => void
        /** Report the facts the menu gates on that only the interface knows. */
        setState: (patch: RendererMenuState) => void
      }
      file: {
        saveDialog: (args: SaveDialogArgs) => Promise<SaveDialogResult>
      }
      schema: {
        detectFormat: (content: string) => Promise<SchemaFormat | null>
        import: (request: SchemaImportRequest) => Promise<SchemaImportResult>
        onProgress: (callback: (progress: SchemaImportProgress) => void) => () => void
      }
      history: {
        save: (entry: HistoryEntry) => Promise<void>
        list: (filter?: HistoryListFilter) => Promise<HistoryEntryListItem[]>
        /** Raw `.http` text for one entry. Use `activityLogToHistoryEntry`
         * from `@/shared/lib/activity-log` to reconstruct the in-memory shape. */
        get: (entryId: string) => Promise<string>
        delete: (entryId: string) => Promise<void>
        clear: () => Promise<void>
        updateSourceFile: (
          oldRelPath: string,
          newRelPath: string,
          isFolder: boolean
        ) => Promise<void>
        countForPath: (relPath: string, isFolder: boolean) => Promise<number>
        deleteForPath: (relPath: string, isFolder: boolean) => Promise<void>
        /** Fires in every window after a run is saved, deleted, cleared or relinked. */
        onChanged: (callback: () => void) => () => void
      }
      certificates: {
        list: (scope: TlsScope) => Promise<TlsScopeSettings>
        addCA: (args: {
          scope: TlsScope
          sourcePath: string
          label?: string
        }) => Promise<CACertEntry>
        addClient: (args: {
          scope: TlsScope
          host: string
          port?: number | null
          type: 'pem' | 'pfx'
          sourcePaths: { certPath?: string; keyPath?: string; pfxPath?: string }
          passphrase?: string | null
        }) => Promise<ClientCertEntry>
        updateCA: (args: {
          scope: TlsScope
          id: string
          patch: { label?: string | null }
        }) => Promise<CACertEntry>
        updateClient: (args: {
          scope: TlsScope
          id: string
          patch: {
            host?: string
            port?: number | null
            passphrase?: string | null
            disabled?: boolean
          }
        }) => Promise<ClientCertEntry>
        remove: (args: {
          scope: TlsScope
          id: string
          kind: 'ca' | 'client'
        }) => Promise<{ removed: true }>
        previewForRequest: (args: { url: string }) => Promise<ClientCertPreview>
        pickSourceFile: (args: {
          kind: 'ca' | 'pemCert' | 'pemKey' | 'pfx'
        }) => Promise<string | null>
        onChanged: (callback: (scope: TlsScope) => void) => () => void
      }
      cookies: {
        setActiveEnvironment: (envId: string | null) => Promise<void>
        list: (envId: string) => Promise<Cookie[]>
        create: (
          envId: string,
          cookie: Omit<Cookie, 'id' | 'createdAt' | 'updatedAt'>
        ) => Promise<Cookie>
        update: (envId: string, cookieId: string, changes: Partial<Cookie>) => Promise<Cookie>
        delete: (envId: string, cookieId: string) => Promise<void>
        clear: (envId: string) => Promise<void>
        deleteJar: (envId: string) => Promise<void>
        onChanged: (callback: (envId: string) => void) => () => void
      }
      display: {
        getScaleFactor: () => Promise<number>
        getZoom: () => Promise<number>
        setZoom: (factor: number) => Promise<number>
        onScaleChanged: (cb: (factor: number) => void) => () => void
        onZoomChanged: (cb: (factor: number) => void) => () => void
      }
      app: {
        getVersion: () => Promise<string>
        getThirdPartyLicenses: () => Promise<string>
        getLicense: () => Promise<LicenseText>
        openExternal: (url: string) => void
      }
      activityPanel: {
        popout: () => Promise<{ ok: true } | { ok: false; reason: string }>
        dock: () => Promise<{ ok: true }>
        focusPopout: () => Promise<boolean>
        isPoppedOut: () => Promise<boolean>
        onPopoutChanged: (callback: (event: ActivityPanelPopoutEvent) => void) => () => void
      }
      uiState: {
        read: (requestId: string) => Promise<RequestUiState | null>
        readAll: () => Promise<RequestUiStateMap>
        write: (requestId: string, state: RequestUiState) => Promise<RequestUiState | null>
        delete: (requestId: string) => Promise<void>
        onChanged: (
          callback: (payload: { requestId: string; state: RequestUiState | null }) => void
        ) => () => void
      }
      treeState: {
        /** Expanded folder paths, or `null` on first run (no file yet). */
        read: () => Promise<string[] | null>
        /** Replace the full set of expanded (workspace-relative) folder paths. */
        write: (paths: string[]) => Promise<void>
      }
      workspaceState: {
        /** Reconciled tab session + workspace prefs; tab paths are absolute. */
        read: () => Promise<WorkspaceStateView>
        /** Persist the open-tab session (absolute tab paths; main converts + validates). */
        setSession: (session: {
          tabs: WorkspaceSessionTab[]
          activeTabIndex: number
        }) => Promise<void>
        /** Persist the active-environment selection. */
        setActiveEnvironment: (id: string | null) => Promise<void>
      }
      binary: {
        selectAndStage: (args?: { sourcePath?: string; confirmed?: boolean }) => Promise<
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
        >
        stat: (args: {
          ref: string
        }) => Promise<{ exists: boolean; sizeBytes?: number; mimeType?: string }>
        remove: (args: { ref: string }) => Promise<{ removed: boolean }>
        list: () => Promise<StagedBinaryEntry[]>
      }
    }
  }
}
