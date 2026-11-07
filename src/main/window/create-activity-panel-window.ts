import { BrowserWindow, nativeTheme } from 'electron'
import { is } from '@electron-toolkit/utils'
import { join } from 'path'
import { readAppSettings } from '../ipc/appsettings.ipc'
import { setFocusedWindowKind } from '../menu/state'
import { windowAppearance } from './window-appearance'

const DEFAULT_SIZE = { width: 800, height: 500 }
const MIN_SIZE = { width: 600, height: 300 }

export function createActivityPanelWindow(parent?: BrowserWindow): BrowserWindow {
  const isMac = process.platform === 'darwin'

  // `themeSource` already carries the user's preference — the main window
  // applied it before any window existed — so this resolves to the same theme
  // the main window is showing, never to the OS theme behind its back.
  const resolvedTheme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  // Read now, not at launch: a palette chosen since then must be in force here.
  const { backgroundColor, additionalArguments } = windowAppearance(
    readAppSettings(),
    resolvedTheme
  )

  const win = new BrowserWindow({
    width: DEFAULT_SIZE.width,
    height: DEFAULT_SIZE.height,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    title: 'Fetchpier — Activity',
    show: false,
    backgroundColor,
    autoHideMenuBar: true,
    parent,
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 12, y: 10 } }
      : { frame: false }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Same handover as the main window, so this one cannot open in a different
      // theme or palette from the window that spawned it.
      additionalArguments,
      // OS-level renderer sandbox (REQ-0060) — match the main window.
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      // Memory tuning (REQ-0059 / PLAN-0060) — match the main window.
      spellcheck: false,
      webgl: false,
      enableWebSQL: false,
      v8CacheOptions: 'code'
    }
  })

  // The popout is frameless on Windows/Linux and renders its own titlebar
  // (PopoutTitleBar). Forward this window's state to its own renderer so the
  // maximize/restore icon and the unfocused styling react. `webContents.send`
  // is per-webContents, so the popout only ever receives its own events; the
  // renderer reuses the existing `window:maximized-changed` / `window:focus-changed`
  // channels exposed by the preload.
  win.on('maximize', () => win.webContents.send('window:maximized-changed', true))
  win.on('unmaximize', () => win.webContents.send('window:maximized-changed', false))
  win.on('focus', () => {
    win.webContents.send('window:focus-changed', true)
    // The menu bar is process-global, so with this window focused it must
    // describe what *this* window can do (REQ menu coherence §6.5).
    setFocusedWindowKind('popout')
  })
  win.on('blur', () => win.webContents.send('window:focus-changed', false))

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/activity-panel-popout.html`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/activity-panel-popout.html'))
  }

  win.once('ready-to-show', () => win.show())

  return win
}
