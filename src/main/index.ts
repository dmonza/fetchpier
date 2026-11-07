import { app, shell, BrowserWindow, ipcMain, session, powerMonitor } from 'electron'

// Disable GPU acceleration only under WSL2, where the GPU stack is unreliable.
// On real Linux, macOS, and Windows, hardware acceleration should remain enabled.
const isWSL = process.platform === 'linux' && !!process.env['WSL_DISTRO_NAME']
if (isWSL) {
  app.commandLine.appendSwitch('disable-gpu')
}

// Chromium tuning (REQ-0059 memory flags + REQ-0061 network-egress flags). ORDER
// IS CRITICAL: these switches must be appended before `app.whenReady()` — Chromium
// and V8 read them while creating the renderer process and the JS isolate, so
// applying them later is a no-op. None of this changes the security model (see
// create-main-window.ts for the per-window webPreferences half of the tuning).
function applyChromiumTuning(): void {
  // Trim V8's young generation. We deliberately do NOT set --max-old-space-size:
  // a hard old-space cap can OOM-crash on large response bodies / parses, which
  // is not worth the savings for an HTTP client (see PLAN-0060 §2 deviation).
  app.commandLine.appendSwitch('js-flags', '--max-semi-space-size=64')

  // Disable Chromium subsystems this app never uses. `disable-features` may only
  // be set ONCE — a second appendSwitch overrides the first — so the memory
  // features (REQ-0059) and the network-egress features (REQ-0061) share one list.
  // Egress-coherence (REQ-0061): a desktop HTTP client never needs Chromium's
  // What's-New surface, optimization-hints downloads, or interest-feed suggestions.
  app.commandLine.appendSwitch(
    'disable-features',
    [
      // REQ-0059 — memory.
      'Translate',
      'BackForwardCache',
      'CalculateNativeWinOcclusion',
      'HardwareMediaKeyHandling',
      'MediaSessionService',
      'SpareRendererForSitePerProcess',
      // REQ-0061 — network egress coherence.
      'ChromeWhatsNewUI',
      'OptimizationHints',
      'InterestFeedContentSuggestions'
    ].join(',')
  )

  // User HTTP responses don't need Chromium's on-disk cache — cap it.
  app.commandLine.appendSwitch('disk-cache-size', String(50 * 1024 * 1024))

  // Network egress invariant (REQ-0061). All application egress goes through
  // `@fetchpier/core` (undici) and the main-process update check. None of
  // Chromium's own background-networking subsystems have a role here; turning
  // them off is the configuration that matches the invariant.
  app.commandLine.appendSwitch('disable-background-networking') // safe-browsing, update pings, etc.
  app.commandLine.appendSwitch('disable-default-apps') // bundled Chrome apps + their updaters
  app.commandLine.appendSwitch('disable-sync') // account-based Chrome Sync (we have no accounts)
  app.commandLine.appendSwitch('disable-component-update') // Widevine/CRL/font component updater → Google
  app.commandLine.appendSwitch('disable-domain-reliability') // DNS/TCP failure telemetry to Google
  app.commandLine.appendSwitch('no-pings') // <a ping="…"> hyperlink auditing beacons
}

applyChromiumTuning()

// ── The startup path ───────────────────────────────────────────────────────
//
// Only what is needed to construct and show a window may be imported here.
// Module evaluation is synchronous and the runtime cannot deliver its readiness
// signal until it finishes, so every dependency reachable from this list
// postpones the earliest moment a window can exist — measured at ~212 ms for
// the graph this file used to pull (REQ deferred cold-path dependencies).
//
// Everything else is loaded by `loadDeferredHandlers()` below, immediately
// after the window exists, concurrently with the renderer parsing its own
// bundle. `npm run audit:coldpath` fails the build if a heavy dependency
// becomes reachable from this list again.
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerWindowHandlers } from './ipc/window.ipc'
import { registerWindowControlsHandlers } from './ipc/window-controls.ipc'
import { registerDisplayHandlers, getSavedZoomFactor, applyZoom } from './ipc/display.ipc'
import { registerAppSettingsHandlers } from './ipc/appsettings.ipc'
import { createMainWindow } from './window/create-main-window'
import {
  rebuildMenu,
  registerMenuIpc,
  setMenuWindow,
  setMenuWindowFactory,
  setMenuWindowHandlers
} from './menu'
import { createRendererUrlPolicy } from './security/renderer-origin'
import { installIpcSenderGuard } from './security/ipc-sender-guard'
import { installPermissionPolicy } from './security/permissions'

/**
 * True only for the app's own renderer documents (the packaged `index.html` /
 * `activity-panel-popout.html`, or the dev-server origin in dev). The single
 * trust decision behind the navigation guard, the IPC sender guard and the
 * session permission policy.
 */
const isAllowedRendererUrl = createRendererUrlPolicy({
  devUrl: is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined,
  rendererDir: join(__dirname, '../renderer')
})

// Installed before any handler exists, so every `ipcMain` registration —
// eager, deferred, and any added later — only answers the app's own documents.
installIpcSenderGuard(ipcMain, isAllowedRendererUrl)

/**
 * Everything that does not have to exist before the window does.
 *
 * Each `import()` becomes its own build artifact, so the dependencies these
 * modules pull — the business layer, the network client, the filesystem
 * watcher, the version comparator — stay out of the startup artifact entirely.
 * Awaited as a group and reported through `app:handlersReady`, which the
 * renderer's bridge holds every operation behind until it settles.
 */
async function loadDeferredHandlers(): Promise<void> {
  const [
    theme,
    appearance,
    locale,
    workspace,
    filesystem,
    shell_,
    request,
    environment,
    secrets,
    history,
    script,
    file,
    cookies,
    certificates,
    schema,
    updates,
    activityPanel,
    uiState,
    treeState,
    workspaceState,
    binary
  ] = await Promise.all([
    import('./ipc/theme.ipc'),
    import('./ipc/appearance.ipc'),
    import('./ipc/locale.ipc'),
    import('./ipc/workspace.ipc'),
    import('./ipc/filesystem.ipc'),
    import('./ipc/shell.ipc'),
    import('./ipc/request.ipc'),
    import('./ipc/environment.ipc'),
    import('./ipc/secrets.ipc'),
    import('./ipc/history.ipc'),
    import('./ipc/script.ipc'),
    import('./ipc/file.ipc'),
    import('./ipc/cookies.ipc'),
    import('./ipc/certificates.ipc'),
    import('./ipc/schema.ipc'),
    import('./ipc/updates.ipc'),
    import('./ipc/activity-panel.ipc'),
    import('./ipc/ui-state.ipc'),
    import('./ipc/tree-state.ipc'),
    import('./ipc/workspace-state.ipc'),
    import('./ipc/binary.ipc')
  ])

  theme.registerThemeHandlers()
  appearance.registerAppearanceHandlers()
  locale.registerLocaleHandlers()
  workspace.registerWorkspaceHandlers()
  filesystem.registerFilesystemHandlers()
  shell_.registerShellHandlers()
  request.registerRequestHandlers()
  environment.registerEnvironmentHandlers()
  secrets.registerSecretsHandlers()
  history.registerHistoryHandlers()
  script.registerScriptHandlers()
  file.registerFileHandlers()
  cookies.registerCookieHandlers()
  certificates.registerCertificateHandlers()
  schema.registerSchemaHandlers()
  updates.registerUpdatesHandlers()
  activityPanel.registerActivityPanelHandlers()
  uiState.registerUiStateHandlers()
  treeState.registerTreeStateHandlers()
  workspaceState.registerWorkspaceStateHandlers()
  binary.registerBinaryHandlers()

  // The quit-time flush has to be synchronous, so the modules that own it are
  // captured here rather than imported at exit. They are already loaded — the
  // handlers above import them — so this resolves from cache.
  const [uiStore, treeStore, workspaceStore] = await Promise.all([
    import('./state/ui-state-store'),
    import('./state/tree-state-store'),
    import('./state/workspace-state-store')
  ])
  flushPendingState = (): void => {
    uiStore.flushSync()
    treeStore.flushSync()
    workspaceStore.flushSync()
  }
}

/**
 * Set once the deferred modules are loaded. Null before that, which can only be
 * the case if the user quit while the window was still filling in — and then
 * there is nothing to flush, because no interface state has been written yet.
 */
let flushPendingState: (() => void) | null = null

/**
 * Resolves once every deferred handler is registered. The renderer's bridge
 * awaits this before it lets any operation through, so an operation requested
 * while the window is still filling in is held rather than refused.
 */
let handlersReady: Promise<void> = Promise.resolve()

/**
 * Runtime half of the network-egress invariant. The renderer is
 * forbidden (by ESLint at source time) from originating network traffic; this
 * Content-Security-Policy is the runtime backstop: even a renderer compromised
 * at runtime cannot `connect-src` / load sub-resources off-origin.
 *
 * `style-src 'unsafe-inline'` is required — CodeMirror 6 and Tailwind/shadcn
 * inject inline <style>. `img-src data:` covers the ResponseViewer's base64
 * image previews. In dev the page is served by Vite, which needs inline/eval
 * scripts (React Fast Refresh) and a WebSocket channel for HMR.
 */
function buildCsp(): string {
  const devUrl = is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined
  if (devUrl) {
    const origin = new URL(devUrl).origin
    const wsOrigin = origin.replace(/^http/, 'ws')
    return [
      `default-src 'self' ${origin}`,
      `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${origin}`,
      `style-src 'self' 'unsafe-inline' ${origin}`,
      `img-src 'self' data: ${origin}`,
      `font-src 'self' data: ${origin}`,
      `connect-src 'self' ${origin} ${wsOrigin}`,
      `object-src 'none'`,
      `base-uri 'none'`,
      `frame-src 'none'`,
      `form-action 'none'`
    ].join('; ')
  }
  return [
    `default-src 'self'`,
    `script-src 'self'`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data:`,
    `font-src 'self' data:`,
    `connect-src 'self'`,
    `object-src 'none'`,
    `base-uri 'none'`,
    `frame-src 'none'`,
    `form-action 'none'`
  ].join('; ')
}

function createWindow(): void {
  const mainWindow = createMainWindow()

  // Apply persisted zoom before showing the window to avoid a visible jump
  const savedZoom = getSavedZoomFactor()
  if (savedZoom !== 1.0) {
    mainWindow.webContents.setZoomFactor(savedZoom)
  }

  registerDisplayHandlers(mainWindow)
  registerWindowHandlers(mainWindow)

  // The menu tracks the window rather than capturing it: on macOS the app
  // outlives its last window and the menu bar stays on screen, so a captured
  // reference would go stale while still being clickable (REQ §6.4).
  setMenuWindow(mainWindow)
  mainWindow.on('closed', () => setMenuWindow(null))

  // Show now rather than on `ready-to-show`. That event waits for the renderer
  // to produce a frame, which on this stack lands *after* the interface has
  // mounted — measured — so waiting for it means the window appears with the
  // finished UI already in it and the startup shell is never seen at all.
  //
  // Showing early is safe here because the window is constructed with the
  // resolved theme's canvas colour, so what appears first is the same colour
  // the shell paints on, not a white flash. It has to happen after the saved
  // bounds, the maximised state and the zoom factor have been applied, or the
  // user watches the window jump into place.
  mainWindow.show()

  // Fallback: show window even if the page fails to load (avoids invisible window)
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error(`Renderer failed to load: [${errorCode}] ${errorDescription}`)
    mainWindow.show()
  })

  // Load the renderer — dev server in development, static file in production
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.fetchpier.app')

  // Avoid loading per-language Hunspell dictionaries (REQ-0059). The window-level
  // `spellcheck: false` covers the main window; this also covers any session
  // created dynamically later.
  session.defaultSession.setSpellCheckerEnabled(false)

  // Network-egress invariant — runtime backstop. Inject a CSP on
  // every response served to the renderer so off-origin connections/resources
  // are refused at the platform level, complementing the source-time (ESLint) and
  // build-time (bundle audit) enforcement.
  const csp = buildCsp()
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp]
      }
    })
  })

  // Electron grants every web permission by default. Only the clipboard is
  // used, and only by the app's own documents; everything else is refused.
  installPermissionPolicy(session.defaultSession, isAllowedRendererUrl)

  // The eager handlers: the ones the window itself needs, plus the readiness
  // channel the renderer's bridge waits on.
  registerAppSettingsHandlers()
  registerWindowControlsHandlers()
  registerMenuIpc()
  ipcMain.handle('app:handlersReady', () => handlersReady)

  // The menu is installed before the first window exists and starts inert: on
  // macOS the bar is on screen for the whole cold start, and every item behind
  // it would otherwise be armed before anything could answer (REQ §6.3).
  // `createWindow` is what the two window-reviving items call (REQ §6.4).
  setMenuWindowFactory(createWindow)
  setMenuWindowHandlers({
    onZoom: (intent) => {
      // Zoom is a window property: it applies to whichever window is frontmost,
      // including the detached activity window (REQ §6.5).
      const win = BrowserWindow.getFocusedWindow()
      if (!win || win.isDestroyed()) return
      applyZoom(
        win,
        intent === 'reset' ? 1.0 : win.webContents.getZoomFactor() + (intent === 'in' ? 0.1 : -0.1)
      )
    },
    onToggleDevTools: () => {
      const win = BrowserWindow.getFocusedWindow()
      if (!win || win.isDestroyed()) return
      if (win.webContents.isDevToolsOpened()) win.webContents.closeDevTools()
      else win.webContents.openDevTools()
    }
  })
  rebuildMenu()

  // Watch shortcuts in development; ignore default shortcuts in production
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Navigation guard (network-egress invariant). Blocks any renderer-initiated top-level
  // navigation away from the packaged renderer documents, on every window (main
  // and activity-panel). Keeps the privileged preload from ever attaching to a
  // remote origin. Programmatic `loadURL`/`loadFile` do not emit `will-navigate`,
  // so the app's own loads never reach it.
  //
  // The new-window handler lives here too (REQ-0113 §6.7). It used to be
  // installed on the main window at creation, so the activity-panel window had
  // no containment at all — the guard beside it was global while the handler
  // that denies new windows was not. Registering both through this hook covers
  // every window, present and future.
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event, url) => {
      if (!isAllowedRendererUrl(url)) event.preventDefault()
    })
    contents.on('will-redirect', (event, url) => {
      if (!isAllowedRendererUrl(url)) event.preventDefault()
    })
    contents.setWindowOpenHandler((details) => {
      try {
        const u = new URL(details.url)
        if (u.protocol === 'https:' || u.protocol === 'http:') {
          shell.openExternal(details.url).catch((err) => console.error(err))
        }
      } catch {
        // Ignore malformed URLs.
      }
      return { action: 'deny' }
    })
  })

  // REQ-0113 §6.3 — a watcher can survive sleep as an object while having stopped
  // delivering events, which nothing can detect. Re-establish it on resume.
  powerMonitor.on('resume', () => {
    // Loaded on demand — the watcher is part of the deferred set, and a resume
    // cannot happen before it has loaded.
    void import('./watcher').then((m) => m.handleSystemResume())
  })

  createWindow()

  // Now that a window exists and the placeholder is on screen, fill in the rest.
  // This runs concurrently with the renderer parsing its own bundle, so the two
  // finish at about the same time; nothing waits on it except the bridge's gate.
  handlersReady = loadDeferredHandlers().catch((err) => {
    console.error('[startup] Deferred handler registration failed:', err)
    throw err
  })

  app.on('activate', function () {
    // On macOS re-create a window when dock icon is clicked and no other windows are open
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Flush any pending per-request UI state to disk before the process exits.
// The renderer debounces writes; this catches the last click of the session.
app.on('before-quit', () => {
  flushPendingState?.()
})
