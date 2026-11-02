import { lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SHELL_GEOMETRY } from '@shared/app-shell'
import { isMenuItemEnabled, type MenuItemId } from '@shared/menu-model'
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '../ui/resizable'
import { ToastContainer } from '../ui/toast-container'
import { useToastStore } from '../../stores/toast'
import { Sidebar } from './Sidebar'
import { TabBar } from './TabBar'
import { TitleBar } from './TitleBar'
import { StatusBar } from './StatusBar'
import { EmptyState } from './EmptyState'
import { UnsavedChangesModal } from './UnsavedChangesModal'
import { WorkspaceRequiredModal } from './WorkspaceRequiredModal'
import { AboutDialog } from './AboutPanel'
import { ThirdPartyLicensesDialog } from './ThirdPartyLicensesDialog'
import { UpdatesPanel } from '../updates/UpdatesPanel'
import { LazyBoundary } from '../ui/LazyBoundary'
import { useWorkspaceStore } from '../../stores/workspace'
import { useEnvironmentStore } from '../../stores/environment'
import { useRequestStore } from '../../stores/request'
import { useUnsavedGuardStore, guardDiscard } from '../../stores/unsavedGuard'
import { useWorkspaceSettingsStore } from '../../stores/workspaceSettings'
import { useDisplayStore } from '../../stores/display'
import { useAppSettingsStore } from '../../stores/appSettings'
import { decideStartupDialogs, postponeUpdatesUntilAboutFlowEnds } from '../../lib/startup-dialogs'
import { useActivityPanelStore } from '../../stores/activityPanel'
import { useSchemaImportStore } from '../../stores/schemaImport'
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts'
import { useFileSyncReconciliation } from '../../hooks/useFileSyncReconciliation'
import { mruCycle } from '../../lib/tab-mru'
import { nextInOrder } from '../../lib/tab-order'
import { ActivityPanelHost } from '../activity-panel/ActivityPanelHost'
import { basenameOfPath } from '../../lib/path'
import {
  SEND_REQUEST_EVENT,
  SAVE_NOW_EVENT,
  URL_BAR_FOCUS_EVENT,
  OPEN_COMMAND_PALETTE_EVENT,
  OPEN_ABOUT_EVENT,
  OPEN_UPDATES_EVENT
} from '../../lib/events'

// Code-split off the renderer cold path (PLAN-0121). These are the only static
// edges from the renderer entry to the CodeMirror chunk (request editor, response
// viewer) plus two cleanly-gated overlays; deferring them keeps the editor stack
// out of the first-paint graph. Each render site is wrapped in <LazyBoundary/>.
const RequestEditor = lazy(() =>
  import('../request/RequestEditor').then((m) => ({ default: m.RequestEditor }))
)
const ResponseViewer = lazy(() =>
  import('../response/ResponseViewer').then((m) => ({ default: m.ResponseViewer }))
)
const CommandPalette = lazy(() =>
  import('./CommandPalette').then((m) => ({ default: m.CommandPalette }))
)
const ImportSchemaModal = lazy(() =>
  import('../schema/ImportSchemaModal').then((m) => ({ default: m.ImportSchemaModal }))
)

export function AppLayout(): React.JSX.Element {
  const { t } = useTranslation()
  const workspacePath = useWorkspaceStore((s) => s.workspacePath)
  const loadLastWorkspace = useWorkspaceStore((s) => s.loadLastWorkspace)
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace)
  const closeWorkspace = useWorkspaceStore((s) => s.closeWorkspace)
  const loadEnvironments = useEnvironmentStore((s) => s.loadEnvironments)
  const loadHttpSettings = useWorkspaceSettingsStore((s) => s.load)
  const applyHttpSettingsFromMain = useWorkspaceSettingsStore((s) => s.applyExternal)
  const activeTabId = useRequestStore((s) => s.activeTabId)
  const hasTabs = useRequestStore((s) => s.tabs.length > 0)
  const openTab = useRequestStore((s) => s.openTab)
  const closeTab = useRequestStore((s) => s.closeTab)

  const setZoomFactor = useDisplayStore((s) => s.setZoomFactor)
  const setScaleFactor = useDisplayStore((s) => s.setScaleFactor)
  const hydrateActivityPanel = useActivityPanelStore((s) => s.hydrate)
  const applyActivityPanelPopoutEvent = useActivityPanelStore((s) => s.applyPopoutEvent)
  const toggleActivityPanel = useActivityPanelStore((s) => s.toggle)

  const [isPaletteOpen, setIsPaletteOpen] = useState(false)
  const [isSidebarVisible, setIsSidebarVisible] = useState(true)
  // MRU tab-cycle session: a frozen snapshot + step count anchored while Ctrl is
  // held (Ctrl+Tab). Committed (and reset) when Ctrl is released.
  const tabCycleRef = useRef<{ snapshot: string[] | null; steps: number }>({
    snapshot: null,
    steps: 0
  })
  const guardPending = useUnsavedGuardStore((s) => s.pending)
  const clearGuard = useUnsavedGuardStore((s) => s.clear)

  // Open tabs follow their file: reconcile every open tab against external
  // filesystem changes (removed-on-disk flag, clean reload, modified conflict).
  // Mounted here so it survives the sidebar being hidden.
  useFileSyncReconciliation()

  // Mount-once latches (PLAN-0121): a deferred overlay loads its chunk on the
  // first open, then stays mounted so it keeps managing its own open/close and
  // exit animations internally — only the first load is deferred off the cold
  // path. The latch is set during render (React's supported "adjust state when a
  // value changes" pattern), so it flips before paint with no extra effect tick.
  const [paletteMounted, setPaletteMounted] = useState(false)
  if (isPaletteOpen && !paletteMounted) setPaletteMounted(true)
  const schemaImportOpen = useSchemaImportStore((s) => s.isOpen)
  const [schemaImportMounted, setSchemaImportMounted] = useState(false)
  if (schemaImportOpen && !schemaImportMounted) setSchemaImportMounted(true)

  // Initialize display store from main process on mount
  useEffect(() => {
    window.api.display.getZoom().then(setZoomFactor).catch(console.error)
    window.api.display.getScaleFactor().then(setScaleFactor).catch(console.error)
    // Keep store in sync when menu zoom shortcuts fire
    const unsubZoom = window.api.display.onZoomChanged(setZoomFactor)
    const unsubScale = window.api.display.onScaleChanged(setScaleFactor)
    return () => {
      unsubZoom()
      unsubScale()
    }
  }, [setZoomFactor, setScaleFactor])

  // Hydrate the activity panel store from persisted AppSettings, and subscribe
  // to popout state-change broadcasts from main.
  useEffect(() => {
    window.api.appSettings
      .get()
      .then((settings) => hydrateActivityPanel(settings.activityPanel))
      .catch(console.error)
    const unsub = window.api.activityPanel.onPopoutChanged(applyActivityPanelPopoutEvent)
    return unsub
  }, [hydrateActivityPanel, applyActivityPanelPopoutEvent])

  // ── Close guard ─────────────────────────────────────────────────────────
  // REQ-0095: route the window/app-close path through the shared guard so it
  // shares one prompt with the workspace-switch / close-workspace / bulk-close
  // flows. guardDiscard checks dirtiness synchronously and confirms the close
  // immediately when nothing is unsaved.
  useEffect(() => {
    return window.api.window.onBeforeClose(() => {
      // Ack first (REQ-0104): proves the renderer is alive so main's
      // close-fallback timeout bounds this acknowledgment, not however long
      // the user takes to answer the guard below.
      window.api.window.sendCloseAck()
      void guardDiscard(useRequestStore.getState().tabs, () => window.api.window.closeConfirmed())
    })
  }, [])
  // ────────────────────────────────────────────────────────────────────────

  useEffect(() => {
    loadLastWorkspace()
  }, [loadLastWorkspace])

  // Startup dialogs. The About opens once per version change and takes
  // precedence over the interval-based update prompt; a prompt that was due is
  // postponed until the About flow ends (see `lib/startup-dialogs.ts`).
  useEffect(() => {
    let cancelled = false
    Promise.all([window.api.appSettings.get(), window.api.app.getVersion()])
      .then(([settings, currentVersion]) => {
        if (cancelled) return
        useAppSettingsStore.setState({ updates: settings.updates, isLoaded: true })
        const decision = decideStartupDialogs({
          lastVersion: settings.lastVersion,
          currentVersion,
          updates: settings.updates,
          nowMs: Date.now()
        })
        if (decision.postponeUpdates) postponeUpdatesUntilAboutFlowEnds()
        if (decision.showAbout) {
          window.dispatchEvent(new CustomEvent(OPEN_ABOUT_EVENT))
        } else if (decision.showUpdates) {
          window.dispatchEvent(new CustomEvent(OPEN_UPDATES_EVENT))
        }
      })
      .catch(console.error)
    return () => {
      cancelled = true
    }
  }, [])

  // Load environments whenever the workspace changes
  useEffect(() => {
    if (workspacePath) {
      loadEnvironments(workspacePath).catch(console.error)
      loadHttpSettings(workspacePath).catch(console.error)
    }
  }, [workspacePath, loadEnvironments, loadHttpSettings])

  // Subscribe to HTTP settings broadcasts from main
  useEffect(() => {
    const unsubscribe = window.api.workspace.onHttpSettingsChanged(applyHttpSettingsFromMain)
    return unsubscribe
  }, [applyHttpSettingsFromMain])

  // REQ-0067: surface the defensive .gitignore generation as a toast.
  useEffect(() => {
    return window.api.workspace.onGitignoreGenerated(() => {
      useToastStore.getState().push(t('workspace.gitignoreGenerated'))
    })
  }, [t])

  // REQ-0113 §6.4: automatic file tracking stopped and could not be recovered.
  // Only ever fires once the retry ladder is exhausted — the point where the
  // problem stops being ours to solve and the user has to know.
  useEffect(() => {
    return window.api.filesystem.onWatchDegraded(() => {
      // Longer than the default: this one tells the user the app has stopped
      // tracking their files, and it is not repeated (main sends it once).
      useToastStore.getState().push(t('workspace.watchDegraded'), {
        type: 'error',
        durationMs: 10_000
      })
    })
  }, [t])

  // Update window title when workspace changes
  useEffect(() => {
    const name = workspacePath ? basenameOfPath(workspacePath) : 'Fetchpier'
    const title = workspacePath ? `Fetchpier — ${name}` : 'Fetchpier'
    window.api.window.setTitle(title).catch(console.error)
  }, [workspacePath])

  // The menu gates on facts only the interface knows. Reporting them is what
  // keeps the menu from offering an action it cannot serve (REQ menu §6.2).
  useEffect(() => {
    window.api.menu.setState({ hasAnyTab: hasTabs, hasActiveTab: activeTabId !== null })
  }, [hasTabs, activeTabId])

  // The same derivation the menu is built from, over the renderer's own state.
  // This window is by definition present, loaded and the main one; the rest
  // comes from the stores.
  const menuState = useMemo(
    () => ({
      hasWindow: true,
      rendererReady: true,
      hasWorkspace: workspacePath !== null,
      hasAnyTab: hasTabs,
      hasActiveTab: activeTabId !== null,
      focusedWindow: 'main' as const
    }),
    [workspacePath, hasTabs, activeTabId]
  )
  const isMenuActionEnabled = useCallback(
    (id: MenuItemId) => isMenuItemEnabled(menuState, id),
    [menuState]
  )

  // Keyboard shortcut handlers (stable refs via useCallback)
  const handleSendRequest = useCallback(() => {
    window.dispatchEvent(new CustomEvent(SEND_REQUEST_EVENT))
  }, [])

  const handleNewRequest = useCallback(() => {
    openTab()
  }, [openTab])

  const handleCloseTab = useCallback(() => {
    if (!activeTabId) return
    // REQ-0095: the Ctrl/Cmd+W shortcut must honour the unsaved-edit guard like
    // the tab's close button does — otherwise it silently drops unsaved edits.
    const tab = useRequestStore.getState().tabs.find((t) => t.id === activeTabId)
    if (!tab) return
    void guardDiscard([tab], async () => closeTab(activeTabId))
  }, [activeTabId, closeTab])

  const handleSaveRequest = useCallback(() => {
    window.dispatchEvent(new CustomEvent(SAVE_NOW_EVENT))
  }, [])

  const handleOpenCommandPalette = useCallback(() => {
    setIsPaletteOpen(true)
  }, [])

  useEffect(() => {
    const handler = (): void => setIsPaletteOpen(true)
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, handler)
    return () => window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, handler)
  }, [])

  const handleFocusUrlBar = useCallback(() => {
    window.dispatchEvent(new CustomEvent(URL_BAR_FOCUS_EVENT))
  }, [])

  const handleToggleSidebar = useCallback(() => {
    setIsSidebarVisible((v) => !v)
  }, [])

  const handleToggleActivityPanel = useCallback(() => {
    toggleActivityPanel()
  }, [toggleActivityPanel])

  // REQ keyboard tree/tab management: Ctrl+Shift+W closes all tabs through the
  // unsaved guard, sparing pinned tabs (so only the unpinned ones are guarded).
  const handleCloseAllTabs = useCallback(() => {
    const tabs = useRequestStore.getState().tabs
    void guardDiscard(
      tabs.filter((t) => t.mode !== 'pinned'),
      async () => useRequestStore.getState().closeAllTabs()
    )
  }, [])

  // Ctrl+Tab MRU cycling: walk a frozen snapshot without re-ordering the MRU until
  // Ctrl is released. `cycleActiveTab` activates without touching the MRU order.
  const stepCycle = useCallback((delta: number) => {
    const { tabs, mruIds, cycleActiveTab } = useRequestStore.getState()
    if (tabs.length < 2) return
    const c = tabCycleRef.current
    if (!c.snapshot) {
      c.snapshot = mruIds.slice()
      c.steps = 0
    }
    c.steps += delta
    const id = mruCycle(c.snapshot, c.steps)
    if (id) cycleActiveTab(id)
  }, [])

  const handleNextTab = useCallback(() => stepCycle(1), [stepCycle])
  const handlePrevTab = useCallback(() => stepCycle(-1), [stepCycle])

  const handleTabCycleEnd = useCallback(() => {
    const c = tabCycleRef.current
    if (!c.snapshot) return
    c.snapshot = null
    c.steps = 0
    // Commit the landed tab to the front of the MRU.
    const { activeTabId, setActiveTab } = useRequestStore.getState()
    if (activeTabId) setActiveTab(activeTabId)
  }, [])

  const handlePageNextTab = useCallback(() => {
    const { tabs, activeTabId, setActiveTab } = useRequestStore.getState()
    const id = nextInOrder(tabs, activeTabId, 1)
    if (id) setActiveTab(id)
  }, [])

  const handlePagePrevTab = useCallback(() => {
    const { tabs, activeTabId, setActiveTab } = useRequestStore.getState()
    const id = nextInOrder(tabs, activeTabId, -1)
    if (id) setActiveTab(id)
  }, [])

  const handleNewCollection = useCallback(() => {
    window.dispatchEvent(new CustomEvent('app:newCollection'))
  }, [])

  // REQ-0095: opening a workspace replaces the whole tab set, same as the
  // sidebar's Open button, so it goes through the unsaved-edit guard.
  const handleOpenWorkspace = useCallback(() => {
    void guardDiscard(useRequestStore.getState().tabs, () => openWorkspace())
  }, [openWorkspace])

  const handleCloseWorkspace = useCallback(() => {
    void guardDiscard(useRequestStore.getState().tabs, async () => closeWorkspace())
  }, [closeWorkspace])

  const handleCloseWindow = useCallback(() => {
    void window.api.window.close()
  }, [])

  const handleZoom = useCallback((intent: 'in' | 'out' | 'reset') => {
    const current = useDisplayStore.getState().zoomFactor
    const next = intent === 'reset' ? 1.0 : current + (intent === 'in' ? 0.1 : -0.1)
    void window.api.display.setZoom(next).catch(console.error)
  }, [])

  // Native menu actions. The ids are the shared menu item ids, so an item and
  // its handler cannot drift apart — the compiler pairs them.
  useEffect(() => {
    return window.api.menu.on((action) => {
      switch (action) {
        case 'file.newRequest':
          handleNewRequest()
          break
        case 'file.newCollection':
          handleNewCollection()
          break
        case 'file.openWorkspace':
          handleOpenWorkspace()
          break
        case 'file.closeWorkspace':
          handleCloseWorkspace()
          break
        case 'file.save':
          handleSaveRequest()
          break
        case 'file.closeTab':
          handleCloseTab()
          break
        case 'file.closeAllTabs':
          handleCloseAllTabs()
          break
        case 'request.send':
          handleSendRequest()
          break
        case 'request.focusUrl':
          handleFocusUrlBar()
          break
        case 'view.commandPalette':
          handleOpenCommandPalette()
          break
        case 'view.toggleSidebar':
          handleToggleSidebar()
          break
        case 'view.toggleActivityPanel':
          handleToggleActivityPanel()
          break
        case 'app.about':
          window.dispatchEvent(new CustomEvent(OPEN_ABOUT_EVENT))
          break
        case 'app.checkUpdates':
          window.dispatchEvent(new CustomEvent(OPEN_UPDATES_EVENT))
          break
        default:
          // Items the main process performs (zoom, developer tools, close
          // window) and the platform roles never reach the interface.
          break
      }
    })
  }, [
    handleNewRequest,
    handleNewCollection,
    handleOpenWorkspace,
    handleCloseWorkspace,
    handleSaveRequest,
    handleCloseTab,
    handleCloseAllTabs,
    handleSendRequest,
    handleFocusUrlBar,
    handleOpenCommandPalette,
    handleToggleSidebar,
    handleToggleActivityPanel
  ])

  useKeyboardShortcuts({
    isEnabled: isMenuActionEnabled,
    onSendRequest: handleSendRequest,
    onNewRequest: handleNewRequest,
    onNewCollection: handleNewCollection,
    onOpenWorkspace: handleOpenWorkspace,
    onCloseTab: handleCloseTab,
    onCloseWindow: handleCloseWindow,
    onSaveRequest: handleSaveRequest,
    onOpenCommandPalette: handleOpenCommandPalette,
    onFocusUrlBar: handleFocusUrlBar,
    onToggleSidebar: handleToggleSidebar,
    onToggleActivityPanel: handleToggleActivityPanel,
    onZoom: handleZoom,
    onNextTab: handleNextTab,
    onPrevTab: handlePrevTab,
    onPageNextTab: handlePageNextTab,
    onPagePrevTab: handlePagePrevTab,
    onTabCycleEnd: handleTabCycleEnd
  })

  return (
    <div className="flex h-screen flex-col bg-background text-foreground overflow-hidden">
      <TitleBar />
      {/* Main panels area — positioned so the docked Activity Panel can overlay it without covering the status bar. */}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <ResizablePanelGroup orientation="horizontal" className="flex-1 overflow-hidden">
          {/* Sidebar */}
          {isSidebarVisible && (
            <>
              <ResizablePanel defaultSize={SHELL_GEOMETRY.sidebarWidth} minSize="12%" maxSize="40%">
                <Sidebar />
              </ResizablePanel>
              <ResizableHandle withHandle />
            </>
          )}

          {/* Main content */}
          <ResizablePanel defaultSize={isSidebarVisible ? '80%' : '100%'} minSize="40%">
            <div className="flex h-full flex-col overflow-hidden">
              {/* Tab bar */}
              <TabBar />

              {/* REQ-0084: when no tab is open, the editor/response split is not
                  rendered — a minimal empty-state panel takes its place. */}
              {hasTabs ? (
                <ResizablePanelGroup orientation="vertical" className="flex-1">
                  <ResizablePanel defaultSize="50%" minSize="20%">
                    <LazyBoundary>
                      <RequestEditor />
                    </LazyBoundary>
                  </ResizablePanel>

                  <ResizableHandle withHandle />

                  <ResizablePanel defaultSize="50%" minSize="15%">
                    <LazyBoundary>
                      <ResponseViewer />
                    </LazyBoundary>
                  </ResizablePanel>
                </ResizablePanelGroup>
              ) : (
                <div className="flex-1 overflow-hidden">
                  <EmptyState />
                </div>
              )}
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>

        {/* Activity Panel docked overlay — sits above the editor/response, below the status bar. */}
        <ActivityPanelHost />
      </div>

      {/* Status bar — always visible at the bottom */}
      <StatusBar />

      {/* Command palette overlay — deferred; mounted on first open (no fallback
          layer needed: the palette renders nothing until its own isOpen is true). */}
      {paletteMounted && (
        <LazyBoundary pending={null}>
          <CommandPalette isOpen={isPaletteOpen} onClose={() => setIsPaletteOpen(false)} />
        </LazyBoundary>
      )}

      {/* Schema import modal — deferred; mounted on first open via the store latch. */}
      {schemaImportMounted && (
        <LazyBoundary pending={null}>
          <ImportSchemaModal />
        </LazyBoundary>
      )}

      {/* About dialog */}
      <AboutDialog />

      {/* Third-party licenses dialog */}
      <ThirdPartyLicensesDialog />

      {/* Updates check panel */}
      <UpdatesPanel />

      {/* Close guard modal */}
      {guardPending && (
        <UnsavedChangesModal
          tabs={guardPending.tabs}
          workspacePath={workspacePath}
          onProceed={guardPending.onProceed}
          onClose={clearGuard}
        />
      )}

      {/* "This save needs a workspace" prompt (REQ menu coherence §6.11) */}
      <WorkspaceRequiredModal />

      {/* Global toast container (REQ-0067 + future toasts) */}
      <ToastContainer />
    </div>
  )
}
