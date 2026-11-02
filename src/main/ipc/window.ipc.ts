import { ipcMain, BrowserWindow, app, shell, dialog } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { LicenseText, WindowPlatform, UnresponsiveCloseStrings } from '../../shared/types'
import { splitLicenseText } from '../../shared/lib/license'
import { setFocusedWindowKind } from '../menu/state'

/**
 * Read a text file shipped alongside the binary. Packaged builds get it from
 * `extraResources`; a dev run reads it from the repo root.
 */
async function readBundledText(fileName: string): Promise<string> {
  const candidatePaths = app.isPackaged
    ? [join(process.resourcesPath, fileName)]
    : [join(app.getAppPath(), fileName), join(process.cwd(), fileName)]
  for (const path of candidatePaths) {
    try {
      return await readFile(path, 'utf-8')
    } catch {
      // try next candidate
    }
  }
  throw new Error(`${fileName} not found`)
}

let thirdPartyLicensesCache: string | null = null

async function loadThirdPartyLicenses(): Promise<string> {
  if (thirdPartyLicensesCache !== null) return thirdPartyLicensesCache
  const text = await readBundledText('THIRD_PARTY_LICENSES.txt')
  thirdPartyLicensesCache = text
  return text
}

let licenseCache: LicenseText | null = null

/**
 * The packaged LICENSE is the single source of the About dialog's copyright
 * line and license body — the app never carries its own copy of that text.
 */
async function loadLicense(): Promise<LicenseText> {
  if (licenseCache !== null) return licenseCache
  const parsed = splitLicenseText(await readBundledText('LICENSE'))
  licenseCache = parsed
  return parsed
}

// ── Close guard (REQ-0104) ──────────────────────────────────────────────────
// Intercept every close attempt (X button, Alt+F4, dock quit, macOS Cmd+Q,
// etc.) and ask the renderer to check for unsaved tabs before actually
// closing. macOS Cmd+Q does NOT emit `window.close` — it goes straight to
// `app.before-quit`, so we listen on both events and dispatch the same
// renderer event.
//
// A UI process that has stopped responding (hung event loop, a listener that
// no longer runs) must never make the app permanently unclosable. The
// renderer acks `window:before-close` immediately, before it runs the
// unsaved-tabs guard, proving its JS event loop is alive; a fallback timeout
// bounds that ack, NOT the user's subsequent Save/Discard/Cancel decision. If
// no ack arrives in time, a native dialog (main-process, so it works even
// with a fully stalled renderer) offers to close anyway.
const CLOSE_ACK_TIMEOUT_MS = 3000

// Bootstrap-only default: shown solely if the renderer crashed/never painted
// before this dialog's first possible appearance, so no translation could
// ever have been pushed. Not a maintained translation — do not add languages
// here; see `pushCloseDialogStrings` in `src/renderer/i18n/index.ts`.
const FALLBACK_CLOSE_STRINGS: UnresponsiveCloseStrings = {
  title: 'Fetchpier is not responding',
  message: 'The application interface has stopped responding.',
  detail: 'Closing now will not check for unsaved changes.',
  keepWaiting: 'Keep Waiting',
  closeAnyway: 'Close Anyway'
}

let cachedCloseStrings: UnresponsiveCloseStrings = FALLBACK_CLOSE_STRINGS

function isUnresponsiveCloseStrings(value: unknown): value is UnresponsiveCloseStrings {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.title === 'string' &&
    typeof v.message === 'string' &&
    typeof v.detail === 'string' &&
    typeof v.keepWaiting === 'string' &&
    typeof v.closeAnyway === 'string'
  )
}

// Re-registered per window (see `registerWindowHandlers`); the globally
// registered handlers below always act on whichever window is current.
let currentWindow: BrowserWindow | null = null
let closingConfirmed = false
let quitRequested = false
let closeAckTimer: NodeJS.Timeout | null = null
let globalHandlersRegistered = false

function clearCloseAckTimer(): void {
  if (closeAckTimer) {
    clearTimeout(closeAckTimer)
    closeAckTimer = null
  }
}

async function showUnresponsiveCloseDialog(): Promise<void> {
  const win = currentWindow
  if (!win || win.isDestroyed() || closingConfirmed) return
  const strings = cachedCloseStrings
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: [strings.keepWaiting, strings.closeAnyway],
    defaultId: 0,
    cancelId: 0,
    title: strings.title,
    message: strings.message,
    detail: strings.detail
  })
  if (response === 1 && !closingConfirmed) {
    closingConfirmed = true
    if (quitRequested) app.quit()
    else if (!win.isDestroyed()) win.close()
  }
}

function askRenderer(): void {
  if (!currentWindow || currentWindow.isDestroyed()) return
  currentWindow.webContents.send('window:before-close')
  clearCloseAckTimer()
  closeAckTimer = setTimeout(() => {
    closeAckTimer = null
    void showUnresponsiveCloseDialog()
  }, CLOSE_ACK_TIMEOUT_MS)
}
// ─────────────────────────────────────────────────────────────────────────

export function registerWindowHandlers(mainWindow: BrowserWindow): void {
  currentWindow = mainWindow
  closingConfirmed = false
  quitRequested = false
  clearCloseAckTimer()

  mainWindow.on('close', (event) => {
    if (!closingConfirmed) {
      event.preventDefault()
      askRenderer()
    }
  })

  mainWindow.on('maximize', () => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:maximized-changed', true)
    }
  })

  mainWindow.on('unmaximize', () => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:maximized-changed', false)
    }
  })

  mainWindow.on('focus', () => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:focus-changed', true)
    }
    // The menu bar follows the focused window (REQ menu coherence §6.5).
    setFocusedWindowKind('main')
    // REQ-0113 §6.2 — the primary recovery lever, and unconditional on purpose.
    // Skipping it while the watcher "looks healthy" would reintroduce exactly the
    // detection problem this design avoids: a watcher that stopped delivering
    // events after a sleep/resume cycle, or on a network share, still reports
    // itself healthy. Debounced inside the watcher module.
    //
    // Loaded on demand: the watcher pulls the filesystem-watching dependency and
    // the business-layer barrel, and this module is registered before the window
    // is created, where neither may be evaluated (REQ deferred cold-path
    // dependencies). By the time a window can take focus the deferred
    // registration has already loaded it, so this resolves from cache; and
    // `requestRescan` returns immediately when no workspace is open, which is
    // the only state in which it could arrive first.
    void import('../watcher').then((m) => m.requestRescan())
  })

  mainWindow.on('blur', () => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:focus-changed', false)
    }
  })

  // The rest of this function registers process-global state (ipcMain
  // channels, app/screen listeners). Re-running `registerWindowHandlers` for
  // a re-created window (concurrent windows) must not
  // re-register these — `ipcMain.handle` throws on a duplicate channel, and
  // `app.on` would otherwise accumulate one more listener per re-creation.
  if (globalHandlersRegistered) return
  globalHandlersRegistered = true

  app.on('before-quit', (event) => {
    if (closingConfirmed) return // re-entry from our own app.quit() — allow it
    if (!currentWindow || currentWindow.isDestroyed()) return // nothing to ask
    event.preventDefault()
    quitRequested = true
    askRenderer()
  })

  ipcMain.on('window:close-ack', (): void => {
    clearCloseAckTimer()
  })

  ipcMain.on('window:setCloseDialogStrings', (_event, strings: unknown): void => {
    if (isUnresponsiveCloseStrings(strings)) cachedCloseStrings = strings
  })

  ipcMain.handle('window:close-confirmed', (): void => {
    if (closingConfirmed) return
    closingConfirmed = true
    clearCloseAckTimer()
    if (quitRequested) app.quit()
    else if (currentWindow && !currentWindow.isDestroyed()) currentWindow.close()
  })

  ipcMain.handle('window:setTitle', (_event, title: string): void => {
    currentWindow?.setTitle(title)
  })

  ipcMain.handle('window:minimize', (): void => {
    currentWindow?.minimize()
  })

  ipcMain.handle('window:maximize-toggle', (): void => {
    if (!currentWindow) return
    if (currentWindow.isMaximized()) {
      currentWindow.unmaximize()
    } else {
      currentWindow.maximize()
    }
  })

  ipcMain.handle('window:close', (): void => {
    currentWindow?.close()
  })

  ipcMain.handle('window:is-maximized', (): boolean => {
    return currentWindow?.isMaximized() ?? false
  })

  ipcMain.handle('window:get-platform', (): WindowPlatform => {
    return process.platform as WindowPlatform
  })

  ipcMain.handle('app:getVersion', (): string => {
    return app.getVersion()
  })

  ipcMain.handle('app:getThirdPartyLicenses', (): Promise<string> => {
    return loadThirdPartyLicenses()
  })

  ipcMain.handle('app:getLicense', (): Promise<LicenseText> => {
    return loadLicense()
  })

  ipcMain.on('app:openExternal', (_event, url: unknown): void => {
    if (typeof url === 'string' && url.startsWith('https://')) {
      shell.openExternal(url).catch(console.error)
    }
  })
}
