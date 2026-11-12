import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react'
import { SEND_REQUEST_EVENT, SAVE_NOW_EVENT, URL_BAR_FOCUS_EVENT } from '../../lib/events'
import { Send, Loader2, Lock, Cookie as CookieIcon, Ban, X, AlertTriangle } from 'lucide-react'
import { useCookieStore } from '../../stores/cookies'
import { CookiesModal } from '../cookies/CookiesModal'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { useCodeMirror } from '../../hooks/useCodeMirror'
import { useRequestStore } from '../../stores/request'
import { useEnvironmentStore } from '../../stores/environment'
import { useWorkspaceStore } from '../../stores/workspace'
import { withWorkspace } from '../../stores/workspaceRequired'
import { useUiStateStore } from '../../stores/uiState'
import { KeyValueEditor } from './KeyValueEditor'
import { BodyEditor } from './BodyEditor'
import { AuthEditor } from './AuthEditor'
import { SettingsEditor } from './SettingsEditor'
import { Badge } from '../ui/badge'
const ScriptsEditor = lazy(() =>
  import('./ScriptsEditor').then((m) => ({ default: m.ScriptsEditor }))
)
import { VariableHighlightInput } from '../ui/VariableHighlightInput'
import { SaveRequestDialog } from './SaveRequestDialog'
import { serializeRequest, splitUrlAndParams, computeFullUrl } from '@shared/lib/http-serializer'
import { hashString } from '@shared/lib/hash'
import { authEcho } from '@shared/lib/auth-echo'
import { implicitDefaultHeaderEntries } from './implicit-headers'
import { serializeTab } from '../../lib/tab-dirty'
import { loadedTabFields } from '../../lib/loaded-tab'
import { requestAfterSave } from '../../lib/request-after-save'
import { LoadNotices } from './LoadNotices'
import { buildHistoryEntry, viewerResponse } from '../../lib/send-result'
import { buildHttpRequestPayload } from './build-send-payload'
import { defaultReqTabForMethod } from './req-tab'
import type {
  RequestEditorState,
  RequestEditorTab,
  KeyValuePair,
  BodyType,
  RawSubtype,
  AuthConfig,
  HttpRequest
} from '../../../shared/types'
import { DEFAULT_REQUEST_STATE, RAW_SUBTYPE_CONTENT_TYPE } from '../../../shared/types'

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const
type HttpMethod = (typeof HTTP_METHODS)[number]

// Stable empty object — avoids creating a new reference on every render when
// there is no active environment, which would cause an infinite re-render loop
// in Zustand (Object.is comparison sees {} !== {} and triggers another update).
const EMPTY_VARIABLES: Record<string, string | null> = {}

const METHOD_COLORS: Record<HttpMethod, string> = {
  GET: 'text-method-get',
  POST: 'text-method-post',
  PUT: 'text-method-put',
  PATCH: 'text-method-patch',
  DELETE: 'text-method-delete',
  HEAD: 'text-method-head',
  OPTIONS: 'text-method-options'
}

// ── Raw history viewer ────────────────────────────────────────────────────────

function RawHistoryViewer({ content }: { content: string }): React.JSX.Element {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  // REQ-0068: history files are now `.http` text — no JSON highlighting.
  // Plain `text` mode preserves the on-disk bytes faithfully.
  useCodeMirror(containerRef, {
    value: content,
    language: 'text',
    onChange: () => {},
    readOnly: true
  })
  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center gap-1.5 border-b border-border bg-surface-2 px-3 py-1.5 text-xs text-muted-foreground shrink-0">
        <Lock className="h-3 w-3 shrink-0" />
        {t('history.rawBanner')}
      </div>
      <div ref={containerRef} className="flex-1 overflow-hidden" />
    </div>
  )
}

// ── RequestEditor ─────────────────────────────────────────────────────────────

/** Thin wrapper: delegates to RawHistoryViewer for raw tabs, otherwise renders the full editor. */
export function RequestEditor(): React.JSX.Element {
  const activeTab = useRequestStore((s) => s.tabs.find((tab) => tab.id === s.activeTabId) ?? null)
  if (activeTab?.rawContent !== undefined) {
    return <RawHistoryViewer content={activeTab.rawContent} />
  }
  return <RequestEditorInner />
}

function RequestEditorInner(): React.JSX.Element {
  const { t } = useTranslation()
  const activeTab = useRequestStore((s) => s.tabs.find((tab) => tab.id === s.activeTabId) ?? null)
  const updateTab = useRequestStore((s) => s.updateTab)
  const markClean = useRequestStore((s) => s.markClean)
  const getActiveVariables = useEnvironmentStore((s) => s.getActiveVariables)
  const activeEnvironmentId = useEnvironmentStore((s) => s.activeEnvironmentId)
  // Derive variables reactively so components re-render on env switch or variable edits.
  // Must return a stable reference: EMPTY_VARIABLES (not a new {}) when there is no
  // active environment, otherwise Zustand sees a different object each render and loops.
  // REQ-0078: the editor surfaces bind to the canonical variable editing behavior,
  // which offers all declared names (plain + secret, by name only) from the unified
  // shape-classified map. Send-time interpolation still uses the plain-only
  // `getActiveVariables()` (secrets resolve in the main process) — unchanged.
  const rawActiveVariables = useEnvironmentStore((s) => {
    if (!s.activeEnvironmentId) return EMPTY_VARIABLES
    return s.environments.find((e) => e.id === s.activeEnvironmentId)?.variables ?? EMPTY_VARIABLES
  })
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const requestsRoot = useWorkspaceStore((s) => s.requestsRoot)

  const request: RequestEditorState = activeTab?.request ?? DEFAULT_REQUEST_STATE
  const isReadOnly = activeTab?.isReadOnly ?? false
  const historyDatetime = activeTab?.historyTimestamp
    ? new Date(activeTab.historyTimestamp).toLocaleString()
    : ''

  // Active sub-tab within the request editor (Params / Headers / Body / Auth / ...).
  // Persisted per workspace tab in the store so switching tabs keeps each one's position;
  // also mirrored to the on-disk uiState map keyed by the request's stable UUID.
  const activeReqTab: RequestEditorTab =
    activeTab?.activeReqTab ?? defaultReqTabForMethod(request.method)
  const setActiveReqTab = useCallback(
    (key: RequestEditorTab) => {
      if (!activeTab) return
      updateTab(activeTab.id, { activeReqTab: key })
      if (activeTab.requestId) {
        useUiStateStore.getState().setForRequest(activeTab.requestId, { activeReqTab: key })
      }
    },
    [activeTab, updateTab]
  )

  // Save-as dialog for unsaved tabs
  const [showSaveDialog, setShowSaveDialog] = useState(false)

  // Cookies modal
  const [showCookiesModal, setShowCookiesModal] = useState(false)
  const cookieCount = useCookieStore((s) => s.cookies.length)
  const activeEnvName = useEnvironmentStore((s) => {
    const id = s.activeEnvironmentId
    if (!id) return null
    return s.environments.find((e) => e.id === id)?.name ?? null
  })
  const cookieJarOverride = request.settings?.disableCookieJar
  const cookieJarDisabled =
    cookieJarOverride && cookieJarOverride.inherit === false && cookieJarOverride.value === true

  // App version for the implicit default User-Agent row (`Fetchpier/<version>`)
  // — the same value the main process sends when the request carries none.
  const [appVersion, setAppVersion] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    window.api.app
      .getVersion()
      .then((v) => {
        if (alive) setAppVersion(v)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  // URL bar editing state — track raw input while focused to avoid cursor jumping
  const [isEditingUrl, setIsEditingUrl] = useState(false)
  const [rawUrlInput, setRawUrlInput] = useState('')

  // Track which tabs have already been loaded from their file
  const loadedTabsRef = useRef<Set<string>>(new Set())

  // Execution ids that were cancelled by the user — used to differentiate
  // a user-initiated cancellation from an unexpected error in the catch block.
  const userCancelledRef = useRef<Set<string>>(new Set())

  // Load file content when a tab with a filePath becomes active for the first time
  useEffect(() => {
    if (!activeTab || !activeTab.filePath) return
    if (loadedTabsRef.current.has(activeTab.id)) return
    // REQ open-tab-file-reconciliation: a file removed on disk has nothing to
    // parse — keep the in-memory buffer and retry once it reappears (the flag
    // clears, which re-runs this effect).
    if (activeTab.removedOnDisk) return

    loadedTabsRef.current.add(activeTab.id)

    window.api.request
      .parseFile(activeTab.filePath)
      .then((parsed) => {
        // The request, the file's id (or the tab's own), the verbatim
        // multi-request tail a save re-emits byte-for-byte, and the reasons the
        // load leaves the tab modified: content a save normalizes away (stray
        // line / relocated comment) and load warnings (a directive a save drops
        // or rewrites).
        const loaded = loadedTabFields(parsed, activeTab.requestId)
        if (!loaded) return
        const tabUpdates: Parameters<typeof updateTab>[1] = { ...loaded }

        // Hydrate persisted UI state (active tab, response sub-tab, script phase)
        // from the on-disk map. Only apply fields that exist; missing ones leave
        // the tab to its current defaults.
        const effectiveId = loaded.requestId
        const uiState = effectiveId ? useUiStateStore.getState().get(effectiveId) : null
        if (uiState) {
          if (uiState.activeReqTab !== undefined) tabUpdates.activeReqTab = uiState.activeReqTab
          if (uiState.activeResponseTab !== undefined)
            tabUpdates.activeResponseTab = uiState.activeResponseTab
          if (uiState.activeScriptPhase !== undefined)
            tabUpdates.activeScriptPhase = uiState.activeScriptPhase
        }

        // REQ-0095: write the loaded content, then capture it as the clean baseline.
        // markClean derives isDirty from the content — a freshly-loaded request is
        // clean, except REQ-0086 leaves it dirty when a query parameter failed to
        // decode (kept raw and flagged) so the user can fix-by-hand or save-to-drop;
        // the persistent advisory banner below explains it.
        updateTab(activeTab.id, tabUpdates)
        markClean(activeTab.id)
      })
      .catch((err) => {
        console.error('[RequestEditor] Failed to parse file:', err)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.id, activeTab?.filePath, activeTab?.removedOnDisk, updateTab])

  // URL bar ref for focus shortcut
  const urlInputRef = useRef<HTMLInputElement>(null)

  // Handle any field change: update store and mark tab as dirty.
  // Saving to disk only happens explicitly via Ctrl+S (saveNow).
  const handleChange = useCallback(
    (changes: Partial<RequestEditorState>) => {
      if (!activeTab) return
      let newRequest = { ...request, ...changes }

      // Switching body type away from 'binary' clears the staged file reference
      // so it doesn't leak into the .http on save. Switching INTO 'binary'
      // leaves binaryFile undefined (the user has to pick a file).
      if (changes.bodyType !== undefined && changes.bodyType !== 'binary') {
        newRequest = { ...newRequest, binaryFile: undefined }
      }

      // REQ-0066: switching to multipart-form seeds an empty parts list and
      // clears formFields/binaryFile so they don't survive on save. Switching
      // away clears multipartParts. Also strip any user-typed
      // `Content-Type: multipart/form-data*` row from headers — the encoder
      // owns that header (with the generated boundary).
      if (changes.bodyType !== undefined) {
        if (changes.bodyType === 'multipart-form') {
          newRequest = {
            ...newRequest,
            multipartParts: newRequest.multipartParts ?? [],
            binaryFile: undefined,
            formFields: [],
            headers: newRequest.headers.filter(
              (h) =>
                !(
                  h.key.toLowerCase() === 'content-type' &&
                  /^multipart\/form-data/i.test(h.value.trim())
                )
            )
          }
        } else {
          newRequest = { ...newRequest, multipartParts: undefined }
        }
      }

      // Auto-manage Content-Type header when body type or raw subtype changes.
      // Managed values: x-www-form-urlencoded + every raw subtype Content-Type.
      const bodyTypeChanged = changes.bodyType !== undefined
      const rawSubtypeChanged = changes.rawSubtype !== undefined
      if (bodyTypeChanged || rawSubtypeChanged) {
        const managedValues = [
          'application/x-www-form-urlencoded',
          ...Object.values(RAW_SUBTYPE_CONTENT_TYPE)
        ].map((v) => v.toLowerCase())

        let targetCT: string | undefined
        if (newRequest.bodyType === 'x-www-form-urlencoded') {
          targetCT = 'application/x-www-form-urlencoded'
        } else if (newRequest.bodyType === 'raw') {
          targetCT = RAW_SUBTYPE_CONTENT_TYPE[newRequest.rawSubtype]
        }

        const existingIdx = newRequest.headers.findIndex(
          (h) => h.key.toLowerCase() === 'content-type'
        )

        if (targetCT) {
          if (existingIdx >= 0) {
            const currentCT = newRequest.headers[existingIdx].value.toLowerCase()
            const isManaged = managedValues.some((v) => currentCT.includes(v))
            // Only replace when the existing header was a previously auto-managed one.
            // Respect any custom Content-Type the user typed.
            if (isManaged) {
              const headers = [...newRequest.headers]
              headers[existingIdx] = { ...headers[existingIdx], value: targetCT, enabled: true }
              newRequest = { ...newRequest, headers }
            }
          } else {
            const newHeader: KeyValuePair = {
              id: `h-ct-${Date.now()}`,
              key: 'Content-Type',
              value: targetCT,
              enabled: true
            }
            newRequest = { ...newRequest, headers: [newHeader, ...newRequest.headers] }
          }
        } else if (existingIdx >= 0 && bodyTypeChanged) {
          // Switching to none/binary — drop Content-Type only if it was auto-managed.
          const currentCT = newRequest.headers[existingIdx].value.toLowerCase()
          if (managedValues.some((v) => currentCT.includes(v))) {
            newRequest = {
              ...newRequest,
              headers: newRequest.headers.filter((_, i) => i !== existingIdx)
            }
          }
        }
      }

      updateTab(activeTab.id, { request: newRequest, isDirty: true })
    },
    [activeTab, request, updateTab]
  )

  const handleSend = useCallback(async () => {
    if (!activeTab) return

    // REQ-0081: the renderer hands the core the base URL and the structured query
    // verbatim (tokens unencoded). No percent-encoding happens here — the core
    // resolves and contextually encodes after variable substitution.
    const httpRequest: HttpRequest = buildHttpRequestPayload(request, getActiveVariables())

    const executionId = crypto.randomUUID()
    updateTab(activeTab.id, {
      isLoading: true,
      error: null,
      scriptResults: undefined,
      cookies: undefined,
      warnings: undefined,
      findings: undefined,
      inFlightExecutionId: executionId
    })

    try {
      const executed = await window.api.request.send(httpRequest, executionId)
      const { scriptResults, error: execError, cookies: cookiesSummary } = executed
      updateTab(activeTab.id, {
        // The viewer may show the response as received (setting off); the
        // activity log below always records the masked one.
        response: viewerResponse(executed) ?? null,
        isLoading: false,
        scriptResults,
        error: execError ?? null,
        inFlightExecutionId: undefined,
        // REQ-0115: feeds the Cookies section. Cleared on every send (below) so a
        // stale chain never reads as belonging to the current response.
        cookies: cookiesSummary,
        warnings: executed.warnings,
        // Passive security findings: drives the Security tab. Cleared on every
        // send (above), like the cookies, so a stale result never shows.
        findings: executed.findings
      })

      // REQ-0074: scripts that called fp.environment.set/remove are persisted to
      // the LOCAL value layer (`localvalues.json`) by the main process — never the
      // shared config.json. The open EnvironmentManager refreshes via the
      // `localValues:changed` event. Nothing to persist here.

      // Auto-save to history when a workspace is open and a response was produced
      const relativeSourceFile =
        workspacePath && activeTab.filePath && activeTab.filePath.startsWith(workspacePath)
          ? activeTab.filePath.slice(workspacePath.length).replace(/^[/\\]/, '')
          : (activeTab.filePath ?? null)
      const entry = workspacePath
        ? buildHistoryEntry({
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            request: httpRequest,
            result: executed,
            sourceFile: relativeSourceFile,
            requestId: activeTab.requestId
          })
        : undefined
      if (entry) {
        // Main broadcasts `history:changed` to every window once the run is on disk.
        window.api.history.save(entry).catch((err) => {
          console.error('[RequestEditor] Failed to save history entry:', err)
        })
      }
    } catch (err) {
      const wasCancelled = userCancelledRef.current.delete(executionId)
      const errorMessage = wasCancelled
        ? t('request.cancelled')
        : err instanceof Error
          ? err.message
          : String(err)
      updateTab(activeTab.id, {
        error: errorMessage,
        isLoading: false,
        response: null,
        inFlightExecutionId: undefined
      })
    }
  }, [activeTab, request, updateTab, getActiveVariables, workspacePath, t])

  const handleCancel = useCallback(() => {
    if (!activeTab) return
    const execId = activeTab.inFlightExecutionId
    if (!execId) return
    userCancelledRef.current.add(execId)
    window.api.request.cancel(execId).catch((err) => {
      console.error('[RequestEditor] Failed to cancel request:', err)
    })
  }, [activeTab])

  // Explicit save triggered by Ctrl+S
  const saveNow = useCallback(async () => {
    if (!activeTab) return
    if (!activeTab.filePath) {
      // REQ menu coherence §6.11: a request can be composed before a workspace
      // exists, so saving one has to lead somewhere. With none open this asks
      // for one instead of doing nothing at all.
      void withWorkspace(() => setShowSaveDialog(true))
      return
    }
    // REQ open-tab-file-reconciliation: while a "changed on disk" conflict is
    // unresolved, a save must not silently overwrite the external edit — the
    // conflict banner (Reload / Keep) is already shown; do nothing here.
    if (activeTab.conflict) return
    try {
      const content = serializeTab({
        request,
        requestId: activeTab.requestId,
        tail: activeTab.tail
      })
      await window.api.filesystem.writeFile(activeTab.filePath, content)
      // REQ-0095: the serializer drops what it cannot write back (malformed
      // params, multipart parts carrying a parse error); mirror that in memory
      // so the in-memory request matches what was written, then recapture the
      // baseline against exactly what was written (`hashString(content)`) so an
      // edit made during the async write survives as still-modified.
      const saved = requestAfterSave(request)
      if (saved !== request) updateTab(activeTab.id, { request: saved })
      // The save normalized away any stray content and acted on the load
      // warnings — clear both reasons.
      if (activeTab.normalizedOnLoad) updateTab(activeTab.id, { normalizedOnLoad: false })
      if (activeTab.loadWarnings) updateTab(activeTab.id, { loadWarnings: undefined })
      // A deliberate save on a removed-on-disk tab re-persists the file at its
      // path; clear the flag optimistically (the watcher add will confirm it).
      if (activeTab.removedOnDisk) updateTab(activeTab.id, { removedOnDisk: false })
      markClean(activeTab.id, hashString(content))
    } catch (err) {
      console.error('[RequestEditor] Failed to force-save file:', err)
    }
    // `withWorkspace` reads the workspace from the store at call time, so this
    // callback no longer closes over `workspacePath`.
  }, [activeTab, request, updateTab, markClean])

  // REQ open-tab-file-reconciliation: resolve a "changed on disk" conflict by
  // adopting the on-disk content (discarding the unsaved edits).
  const reloadFromDisk = useCallback(async () => {
    if (!activeTab?.filePath) return
    try {
      const parsed = await window.api.request.parseFile(activeTab.filePath)
      const loaded = loadedTabFields(parsed, activeTab.requestId)
      if (!loaded) return
      updateTab(activeTab.id, { ...loaded, conflict: false })
      markClean(activeTab.id, hashString(serializeTab(loaded)))
    } catch (err) {
      console.error('[RequestEditor] Failed to reload from disk:', err)
    }
  }, [activeTab, updateTab, markClean])

  // Resolve a conflict by keeping the unsaved edits; the next save overwrites disk.
  const keepEditing = useCallback(() => {
    if (!activeTab) return
    updateTab(activeTab.id, { conflict: false })
  }, [activeTab, updateTab])

  const handleSaveAs = useCallback(
    async (name: string, folderPath: string) => {
      if (!activeTab) return
      setShowSaveDialog(false)
      try {
        const filePath = await window.api.filesystem.createRequest(folderPath, name)
        const content = serializeRequest(request, activeTab.requestId)
        await window.api.filesystem.writeFile(filePath, content)
        const title = name.replace(/\.http$/, '')
        // REQ-0095: mirror the serializer's drops in memory, set the new
        // path/title, then recapture the baseline.
        updateTab(activeTab.id, { filePath, title, request: requestAfterSave(request) })
        markClean(activeTab.id, hashString(content))
      } catch (err) {
        console.error('[RequestEditor] Failed to save new request:', err)
      }
    },
    [activeTab, request, updateTab, markClean]
  )

  // Latest request kept in a ref so the global-event listeners below stay stable
  // and don't re-subscribe on every URL/param keystroke.
  const requestRef = useRef(request)
  useEffect(() => {
    requestRef.current = request
  })

  // Listen to global app events dispatched from AppLayout keyboard shortcuts
  useEffect(() => {
    const onSend = (): void => {
      // While a request is in flight, the same gesture cancels it.
      if (activeTab?.inFlightExecutionId) {
        handleCancel()
        return
      }
      handleSend().catch(console.error)
    }
    const onSave = (): void => {
      saveNow().catch(console.error)
    }
    const onFocusUrl = (): void => {
      const { url, params } = requestRef.current
      setRawUrlInput(computeFullUrl(url, params))
      setIsEditingUrl(true)
      urlInputRef.current?.focus()
      urlInputRef.current?.select()
    }

    window.addEventListener(SEND_REQUEST_EVENT, onSend)
    window.addEventListener(SAVE_NOW_EVENT, onSave)
    window.addEventListener(URL_BAR_FOCUS_EVENT, onFocusUrl)

    return () => {
      window.removeEventListener(SEND_REQUEST_EVENT, onSend)
      window.removeEventListener(SAVE_NOW_EVENT, onSave)
      window.removeEventListener(URL_BAR_FOCUS_EVENT, onFocusUrl)
    }
  }, [handleSend, handleCancel, saveNow, activeTab?.inFlightExecutionId])

  const reqTabs: { key: RequestEditorTab; label: string }[] = [
    { key: 'params', label: t('request.tabs.params') },
    { key: 'auth', label: t('request.tabs.auth') },
    { key: 'headers', label: t('request.tabs.headers') },
    { key: 'body', label: t('request.tabs.body') },
    { key: 'scripts', label: t('request.tabs.scripts') },
    { key: 'settings', label: t('request.tabs.settings') }
  ]

  const overrideCount = Object.values(request.settings ?? {}).filter(
    (v) => v && (v as { inherit: boolean }).inherit === false
  ).length

  // Read-only entries projected from the active auth scheme (REQ-0083 §6.3): a
  // header echo shows in the Headers tab, a query echo in the Params tab.
  const echo = authEcho(request.auth)
  const managedHeaderEntries = echo.header
    ? [{ key: echo.header.name, value: echo.header.value }]
    : []
  const managedParamEntries = echo.query ? [{ key: echo.query.key, value: echo.query.value }] : []

  // A manual header / parameter the active scheme owns is not shown at all — the
  // scheme is the sole source for that name, represented by the read-only managed
  // row (REQ-0083 §6.4, owner decision).
  const echoHeaderName = echo.header?.name.trim().toLowerCase()
  const echoParamName = echo.query?.key.trim().toLowerCase()
  const visibleParams = echoParamName
    ? request.params.filter((p) => p.key.trim().toLowerCase() !== echoParamName)
    : request.params

  const methodColor =
    (request.method as HttpMethod) in METHOD_COLORS
      ? METHOD_COLORS[request.method as HttpMethod]
      : 'text-foreground'

  return (
    <div className="flex h-full flex-col bg-background">
      {showSaveDialog && workspacePath && requestsRoot && (
        <SaveRequestDialog
          workspacePath={workspacePath}
          requestsRoot={requestsRoot}
          onConfirm={(name, folder) => handleSaveAs(name, folder).catch(console.error)}
          onCancel={() => setShowSaveDialog(false)}
        />
      )}

      {/* Read-only banner for history tabs */}
      {isReadOnly && (
        <div className="flex items-center gap-1.5 border-b border-border bg-surface-2 px-3 py-1.5 text-xs text-muted-foreground shrink-0">
          <Lock className="h-3 w-3 shrink-0" />
          {t('history.readOnlyBanner', { datetime: historyDatetime })}
        </div>
      )}

      {/* File path breadcrumb — merged visually above the URL bar */}
      {activeTab && !isReadOnly && (
        <div className="flex h-6 items-center gap-2 px-3 pt-1 shrink-0">
          <div className="flex min-w-0 flex-1 items-baseline overflow-hidden font-mono text-[11px]">
            {activeTab.filePath ? (
              (() => {
                const rel =
                  workspacePath && activeTab.filePath.startsWith(workspacePath)
                    ? activeTab.filePath
                        .slice(workspacePath.length)
                        .replace(/^[/\\]/, '')
                        .replace(/\\/g, '/')
                    : activeTab.filePath.replace(/\\/g, '/')
                const lastSlash = rel.lastIndexOf('/')
                const dir = lastSlash >= 0 ? rel.slice(0, lastSlash + 1) : ''
                const name = (lastSlash >= 0 ? rel.slice(lastSlash + 1) : rel).replace(
                  /\.http$/,
                  ''
                )
                return (
                  <>
                    {dir && <span className="min-w-0 truncate text-muted-foreground">{dir}</span>}
                    <span className="shrink-0 font-semibold text-foreground">{name}</span>
                  </>
                )
              })()
            ) : (
              <span className="text-muted-foreground">{t('request.unsaved')}</span>
            )}
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-5 shrink-0 px-1.5 text-[11px]"
            disabled={!activeTab.isDirty}
            onClick={() => saveNow().catch(console.error)}
          >
            {t('request.save')}
          </Button>
        </div>
      )}

      {/* URL Bar */}
      <div
        className={cn(
          'flex items-center gap-2 border-b border-border px-2 pb-2',
          activeTab && !isReadOnly ? 'pt-1' : 'pt-2'
        )}
      >
        {/* Method selector */}
        <Select
          value={request.method}
          onValueChange={(value) => handleChange({ method: value })}
          disabled={isReadOnly}
        >
          <SelectTrigger
            size="sm"
            className={cn(
              'h-8 w-auto gap-1 px-2 text-xs font-semibold',
              methodColor,
              isReadOnly && 'cursor-default opacity-75'
            )}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {HTTP_METHODS.map((m) => (
              <SelectItem
                key={m}
                value={m}
                className={cn('text-xs font-semibold', METHOD_COLORS[m as HttpMethod])}
              >
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* URL input — shows full URL (base + params); bidirectional sync with Params tab */}
        <VariableHighlightInput
          ref={urlInputRef}
          value={isEditingUrl ? rawUrlInput : computeFullUrl(request.url, request.params)}
          onFocus={() => {
            if (isReadOnly) return
            setRawUrlInput(computeFullUrl(request.url, request.params))
            setIsEditingUrl(true)
          }}
          onChange={(e) => {
            if (isReadOnly) return
            const raw = e.target.value
            setRawUrlInput(raw)
            const { baseUrl, params } = splitUrlAndParams(raw)
            handleChange({ url: baseUrl, params })
          }}
          onBlur={() => setIsEditingUrl(false)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || isReadOnly) return
            if (activeTab?.inFlightExecutionId) handleCancel()
            else handleSend().catch(console.error)
          }}
          readOnly={isReadOnly}
          placeholder={t('request.urlPlaceholder')}
          variables={rawActiveVariables}
          className={cn(
            'h-8 flex-1 rounded-md border border-border-default bg-background',
            'focus-within:ring-1 focus-within:ring-ring',
            isReadOnly && 'cursor-default opacity-75'
          )}
          inputClassName="px-3 text-sm focus:outline-none"
        />

        {/* Send button — flips to Cancel while a request is in flight */}
        {!isReadOnly &&
          (() => {
            const inFlight = Boolean(activeTab?.inFlightExecutionId)
            return (
              <Button
                size="sm"
                variant={inFlight ? 'destructive' : 'default'}
                className="h-8 gap-1.5 focus-glow"
                onClick={inFlight ? handleCancel : handleSend}
              >
                {inFlight ? (
                  <X className="h-3.5 w-3.5" />
                ) : activeTab?.isLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Send className="h-3.5 w-3.5" />
                )}
                {inFlight ? t('request.cancel') : t('request.send')}
              </Button>
            )
          })()}
      </div>

      {/* REQ open-tab-file-reconciliation: the backing file changed on disk while
          this tab had unsaved edits. A save is blocked until the user resolves
          the conflict — reload the on-disk content (discarding edits) or keep
          editing (the next save overwrites disk). */}
      {activeTab?.conflict && (
        <div className="flex items-start gap-2 border-b border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning-text shrink-0">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <div className="flex-1 space-y-1">
            <p className="font-medium">{t('request.diskConflict.title')}</p>
            <p className="opacity-90">{t('request.diskConflict.detail')}</p>
            <div className="flex gap-2 pt-0.5">
              <button
                type="button"
                onClick={() => void reloadFromDisk()}
                className="rounded border border-warning/50 px-2 py-0.5 font-medium hover:bg-warning/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {t('request.diskConflict.reload')}
              </button>
              <button
                type="button"
                onClick={keepEditing}
                className="rounded border border-warning/50 px-2 py-0.5 font-medium hover:bg-warning/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {t('request.diskConflict.keep')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* REQ open-tab-file-reconciliation: the backing file was moved/deleted by
          an external tool. The tab keeps its content; a deliberate save
          re-persists the file at this path. */}
      {activeTab?.removedOnDisk && !activeTab.conflict && (
        <div className="flex items-start gap-2 border-b border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning-text shrink-0">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <div className="space-y-0.5">
            <p className="font-medium">{t('request.removedOnDisk.title')}</p>
            <p className="opacity-90">{t('request.removedOnDisk.detail')}</p>
          </div>
        </div>
      )}

      {/* REQ-0086: persistent advisory shown while the request holds a query
          parameter that failed percent-decoding on load. Never mute — it is
          always paired with its reason and removal wording. Disappears once the
          parameter is edited (flag cleared) or the request is saved (dropped). */}
      {request.params.some((p) => p.malformed) && (
        <div className="flex items-start gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive shrink-0">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <div className="space-y-0.5">
            <p className="font-medium">{t('request.malformedQuery.title')}</p>
            <p className="text-destructive/90">
              {t('request.malformedQuery.detail', {
                keys: request.params
                  .filter((p) => p.malformed)
                  .map((p) => p.key)
                  .join(', ')
              })}
            </p>
          </div>
        </div>
      )}

      {/* `.http` round-trip fidelity: a malformed multipart part is dropped on
          save — surface it as modified-with-a-reason (CA-11). */}
      {request.multipartParts?.some((p) => (p as { parseError?: string }).parseError) && (
        <div className="flex items-start gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive shrink-0">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <div className="space-y-0.5">
            <p className="font-medium">{t('request.malformedPart.title')}</p>
            <p className="text-destructive/90">{t('request.malformedPart.detail')}</p>
          </div>
        </div>
      )}

      {/* What the file said that the editor could not take as written: load
          warnings (a save drops or rewrites them) and an invalid binary
          reference (kept, but the send is refused until a file is attached). */}
      {activeTab && <LoadNotices request={request} loadWarnings={activeTab.loadWarnings} />}

      {/* Stray, non-comment/non-header content was dropped on load; a save
          normalizes it away (CA-10 / D19). */}
      {activeTab?.normalizedOnLoad && (
        <div className="flex items-start gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive shrink-0">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <div className="space-y-0.5">
            <p className="font-medium">{t('request.strayContent.title')}</p>
            <p className="text-destructive/90">{t('request.strayContent.detail')}</p>
          </div>
        </div>
      )}

      {/* Informational: the file holds more than one request; only the first is
          shown and executed, the rest are preserved (CA-09). Does not mark the
          tab modified. */}
      {activeTab?.tail && (
        <div className="flex items-start gap-2 border-b border-border bg-surface-2 px-3 py-2 text-xs text-muted-foreground shrink-0">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <div className="space-y-0.5">
            <p className="font-medium">{t('request.multiRequest.title')}</p>
            <p>{t('request.multiRequest.detail')}</p>
          </div>
        </div>
      )}

      {/* Request config tabs */}
      <div className="flex h-8 items-center border-b border-border bg-surface-2 shrink-0">
        {reqTabs.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setActiveReqTab(key)}
            className={cn(
              'flex h-8 items-center gap-1.5 px-4 text-xs transition-colors',
              activeReqTab === key
                ? 'border-b-2 border-primary text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {label}
            {key === 'settings' && overrideCount > 0 && (
              <Badge variant="outline" className="text-[10px]">
                {t('request.settings.overriddenCount', { count: overrideCount })}
              </Badge>
            )}
          </button>
        ))}
        <button
          type="button"
          onClick={() => activeEnvName && setShowCookiesModal(true)}
          disabled={!activeEnvName}
          title={activeEnvName ? '' : t('cookies.selectEnvHint')}
          className={cn(
            'ml-auto flex h-8 items-center gap-1.5 px-3 text-xs transition-colors',
            activeEnvName
              ? 'text-muted-foreground hover:text-foreground'
              : 'cursor-not-allowed text-muted-foreground/50'
          )}
        >
          {cookieJarDisabled ? (
            <Ban className="h-3.5 w-3.5" />
          ) : (
            <CookieIcon className="h-3.5 w-3.5" />
          )}
          {t('cookies.trigger', { count: activeEnvName ? cookieCount : 0 })}
        </button>
      </div>

      {showCookiesModal && (
        <CookiesModal
          environmentId={activeEnvironmentId}
          environmentName={activeEnvName}
          currentUrl={request.url}
          open={showCookiesModal}
          onOpenChange={setShowCookiesModal}
        />
      )}

      {/* Tab content */}
      <div className="flex-1 overflow-auto">
        {activeReqTab === 'params' && (
          <KeyValueEditor
            pairs={visibleParams}
            onChange={(params) => handleChange({ params })}
            keyPlaceholder={t('request.params.keyPlaceholder')}
            valuePlaceholder={t('request.params.valuePlaceholder')}
            variables={rawActiveVariables}
            readOnly={isReadOnly}
            managedEntries={managedParamEntries}
          />
        )}

        {activeReqTab === 'headers' && (
          <KeyValueEditor
            pairs={(request.bodyType === 'multipart-form'
              ? request.headers.filter((h) => h.key.toLowerCase() !== 'content-type')
              : request.headers
            ).filter((h) => !echoHeaderName || h.key.trim().toLowerCase() !== echoHeaderName)}
            onChange={(visibleHeaders) => {
              // When in multipart mode, the visible list excludes the
              // Content-Type row(s); merge any preserved CT entries back in
              // before persisting to keep round-trip clean for users who
              // toggle modes.
              if (request.bodyType === 'multipart-form') {
                const preservedCT = request.headers.filter(
                  (h) => h.key.toLowerCase() === 'content-type'
                )
                handleChange({ headers: [...visibleHeaders, ...preservedCT] })
              } else {
                handleChange({ headers: visibleHeaders })
              }
            }}
            showHeaderAutocomplete={!isReadOnly}
            keyPlaceholder={t('request.headers.keyPlaceholder')}
            valuePlaceholder={t('request.headers.valuePlaceholder')}
            variables={rawActiveVariables}
            readOnly={isReadOnly}
            managedEntries={managedHeaderEntries}
            defaultEntries={implicitDefaultHeaderEntries(request.headers, appVersion)}
          />
        )}

        {activeReqTab === 'body' && (
          <BodyEditor
            bodyType={request.bodyType}
            rawSubtype={request.rawSubtype}
            body={request.body}
            formFields={request.formFields}
            binaryFile={request.binaryFile}
            multipartParts={request.multipartParts}
            workspacePath={workspacePath}
            onBodyTypeChange={(bodyType: BodyType) => handleChange({ bodyType })}
            onRawSubtypeChange={(rawSubtype: RawSubtype) => handleChange({ rawSubtype })}
            onBodyChange={(body) => handleChange({ body })}
            onFormFieldsChange={(formFields) => handleChange({ formFields })}
            onBinaryFileChange={(binaryFile) => handleChange({ binaryFile })}
            onMultipartPartsChange={(multipartParts) => handleChange({ multipartParts })}
            variables={rawActiveVariables}
            readOnly={isReadOnly}
          />
        )}

        {activeReqTab === 'auth' && (
          <AuthEditor
            auth={request.auth}
            onChange={(auth: AuthConfig) => handleChange({ auth })}
            variables={rawActiveVariables}
            readOnly={isReadOnly}
          />
        )}

        {activeReqTab === 'scripts' && (
          <Suspense fallback={<div className="h-full w-full" />}>
            <ScriptsEditor
              preRequestScript={request.preRequestScript}
              postResponseScript={request.postResponseScript}
              onPreRequestChange={(preRequestScript) => handleChange({ preRequestScript })}
              onPostResponseChange={(postResponseScript) => handleChange({ postResponseScript })}
              activePhase={activeTab?.activeScriptPhase}
              onPhaseChange={(phase) => {
                if (!activeTab) return
                updateTab(activeTab.id, { activeScriptPhase: phase })
                if (activeTab.requestId) {
                  useUiStateStore.getState().setForRequest(activeTab.requestId, {
                    activeScriptPhase: phase
                  })
                }
              }}
              readOnly={isReadOnly}
            />
          </Suspense>
        )}

        {activeReqTab === 'settings' && (
          <SettingsEditor
            settings={request.settings ?? {}}
            onChange={(settings) => handleChange({ settings })}
            readOnly={isReadOnly}
            url={request.url}
          />
        )}
      </div>
    </div>
  )
}
