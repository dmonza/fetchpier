import { app, BrowserWindow, BrowserWindowConstructorOptions, nativeTheme, screen } from 'electron'
import { join } from 'path'
import { readAppSettings, writeAppSettings } from '../ipc/appsettings.ipc'
import {
  appearanceFrom,
  clearStartupWorkspaceHint,
  readStartupWorkspace,
  setStartupWorkspaceHint,
  windowAppearance
} from './window-appearance'
import type { WindowState } from '../../shared/types'

const DEFAULT_SIZE = { width: 1200, height: 800 }

function sanitizeBounds(state: WindowState | undefined): {
  x?: number
  y?: number
  width: number
  height: number
} {
  if (!state) return { ...DEFAULT_SIZE }
  const width = Math.max(600, state.width)
  const height = Math.max(400, state.height)
  if (state.x === undefined || state.y === undefined) {
    return { width, height }
  }
  // Only restore position if it still intersects some display.
  const displays = screen.getAllDisplays()
  const visible = displays.some((d) => {
    const b = d.bounds
    return (
      state.x! + width > b.x &&
      state.x! < b.x + b.width &&
      state.y! + height > b.y &&
      state.y! < b.y + b.height
    )
  })
  return visible ? { x: state.x, y: state.y, width, height } : { width, height }
}

export function createMainWindow(): BrowserWindow {
  const isMac = process.platform === 'darwin'

  const platformOptions: BrowserWindowConstructorOptions = isMac
    ? {
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 12, y: 10 }
      }
    : {
        frame: false
      }

  const settings = readAppSettings()
  const saved = settings.windowState
  const bounds = sanitizeBounds(saved)

  // Resolve the theme before the window exists. This one assignment decides
  // three surfaces a renderer cannot reach: the colour the window is
  // constructed with, the theme the platform applies to native decorations,
  // and — via `prefers-color-scheme` — the theme the startup shell paints
  // itself in. Doing it after the window is created would leave an explicit
  // preference that disagrees with the OS visibly flipping once the interface
  // mounts. See `src/renderer/assets/main.css` (#root:empty).
  // `readAppSettings` already defaults this, so the fallback only matters if a
  // future caller hands over a document that skipped that merge — in which case
  // startup still has to proceed rather than assign `undefined`.
  nativeTheme.themeSource = settings.theme ?? 'system'
  const resolvedTheme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  // The stored palette decides the canvas too, and travels with the resolved
  // theme to the preload, so the first frame is already in the user's palette.
  // The interface restores the last workspace only after it has loaded, so the
  // palette of that workspace is read here too — and held until the restore
  // settles, so the interface's first read agrees with this window.
  const startup = readStartupWorkspace(app.getPath('userData'))
  if (startup.restorable) setStartupWorkspaceHint(startup.raw)
  else clearStartupWorkspaceHint()
  const { backgroundColor, additionalArguments } = windowAppearance(
    appearanceFrom(settings, startup.restorable ? startup.raw : null),
    resolvedTheme
  )

  const win = new BrowserWindow({
    ...bounds,
    title: 'Fetchpier',
    show: false,
    backgroundColor,
    // On macOS the menu lives in the system menu bar, so hiding the window's own
    // menu bar is fine. On Windows/Linux the window-level menu bar is the only
    // place the native menu appears, but with frame:false it is already gone.
    autoHideMenuBar: true,
    ...platformOptions,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Hand the resolved theme and the palette to the renderer process instead
      // of making it ask. The preload reads them at document start, ahead of the
      // stylesheet, so the startup shell paints theme- and palette-correct
      // without a round trip that would stall the renderer whenever this process
      // is busy loading.
      additionalArguments,
      // OS-level renderer sandbox (REQ-0060). The preload was audited to need only the
      // sandboxed-preload API surface; `test/e2e/sandbox.spec.ts` pins the setting on.
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      // Memory tuning (REQ-0059 / PLAN-0060) — none used by an HTTP client.
      spellcheck: false,
      webgl: false,
      enableWebSQL: false,
      v8CacheOptions: 'code'
    }
  })

  if (saved?.isMaximized) {
    win.maximize()
  }

  const persist = (): void => {
    const isMaximized = win.isMaximized()
    const bounds = isMaximized ? win.getNormalBounds() : win.getBounds()
    writeAppSettings({
      windowState: {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        isMaximized
      }
    })
  }

  let saveTimer: NodeJS.Timeout | null = null
  const schedulePersist = (): void => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(persist, 400)
  }

  win.on('resize', schedulePersist)
  win.on('move', schedulePersist)
  win.on('maximize', persist)
  win.on('unmaximize', persist)
  win.on('close', () => {
    if (saveTimer) clearTimeout(saveTimer)
    persist()
  })

  return win
}
