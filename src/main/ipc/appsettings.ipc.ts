import { ipcMain, app } from 'electron'
import { join } from 'path'
import { readFileSync } from 'fs'
// The narrow subpath, not the barrel. This module is read before the main
// window is created, and the barrel would drag the request domain — and with it
// the network client — onto that path, postponing the window by ~200 ms
// (REQ deferred cold-path dependencies). The subpath carries nothing but the
// durable-write helpers.
import { atomicWriteFileSync } from '@fetchpier/core/atomic-write'
import type {
  ActivityPanelSettings,
  AppearancePalettes,
  AppSettings,
  Theme,
  TlsScopeSettings,
  UpdatesSettings
} from '../../shared/types'
import { DEFAULT_UPDATES_SETTINGS, THEMES } from '../../shared/types'

const SETTINGS_FILE = join(app.getPath('userData'), 'appsettings.json')

const INTERVAL_DAYS_MIN = 1
const INTERVAL_DAYS_MAX = 365

const DEFAULTS: AppSettings = {
  zoomFactor: 1.0,
  language: 'en',
  requestTimeoutSeconds: 30,
  proxy: {
    enabled: false,
    url: '',
    username: '',
    password: ''
  },
  lastVersion: null,
  updates: { ...DEFAULT_UPDATES_SETTINGS },
  theme: 'system',
  hideSecretsInResponses: true
}

/** Anything that isn't a version string reads as "never shown" (see AppSettings). */
function sanitizeLastVersion(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/**
 * The theme is read before the main window exists and decides the colour it is
 * constructed with, so an out-of-range value must degrade rather than throw:
 * anything outside the permitted set reads as `'system'`.
 */
function sanitizeTheme(value: unknown): Theme {
  return THEMES.includes(value as Theme) ? (value as Theme) : 'system'
}

function mergeDefaults(parsed: Partial<AppSettings>): AppSettings {
  const updates = { ...DEFAULTS.updates, ...(parsed.updates ?? {}) }
  // If `lastCheckAt` ends up null (default constant, manually edited file,
  // partial migration from an older version), stamp it now so the runtime
  // never sees null. `shouldAutoOpenUpdates` treats null as "never prompted →
  // prompt now", which would fire the dialog on the very first IPC call.
  if (updates.lastCheckAt === null) {
    updates.lastCheckAt = initialLastCheckAt(updates.intervalDays)
  }
  return {
    ...DEFAULTS,
    ...parsed,
    lastVersion: sanitizeLastVersion(parsed.lastVersion),
    theme: sanitizeTheme(parsed.theme),
    // Safe default: only an explicit `false` shows secrets in the response viewer.
    hideSecretsInResponses: parsed.hideSecretsInResponses !== false,
    proxy: { ...DEFAULTS.proxy, ...(parsed.proxy ?? {}) },
    updates,
    ...(parsed.tls ? { tls: parsed.tls } : {}),
    ...(parsed.activityPanel ? { activityPanel: parsed.activityPanel } : {})
  }
}

/**
 * Produce the initial `lastCheckAt` stamp for a brand-new install so the
 * auto-update prompt fires one day after first launch, regardless of the
 * user's configured interval. Formula: `now - (intervalDays - 1) days`,
 * which makes `shouldAutoOpenUpdates` return true exactly 24 h later.
 */
function initialLastCheckAt(intervalDays: number): string {
  const dayMs = 24 * 60 * 60 * 1000
  const offsetDays = Math.max(0, intervalDays - 1)
  return new Date(Date.now() - offsetDays * dayMs).toISOString()
}

export function readAppSettings(): AppSettings {
  try {
    const raw = readFileSync(SETTINGS_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<AppSettings>
    return mergeDefaults(parsed)
  } catch (err) {
    // First-run / unreadable: mergeDefaults() already stamps `lastCheckAt`
    // when it's missing or null, so we just persist what it returned.
    const initial = mergeDefaults({})
    if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      try {
        atomicWriteFileSync(SETTINGS_FILE, JSON.stringify(initial, null, 2))
      } catch (writeErr) {
        console.error('[appsettings] Failed to initialize:', writeErr)
      }
    }
    return initial
  }
}

/** Patch accepting partial values for nested sections. */
export interface AppSettingsPatch {
  zoomFactor?: number
  language?: string
  requestTimeoutSeconds?: number
  proxy?: Partial<AppSettings['proxy']>
  windowState?: AppSettings['windowState']
  /** Stamped when the About dialog is shown for a version it doesn't already hold. */
  lastVersion?: string | null
  /** The user's theme preference — see `AppSettings.theme`. */
  theme?: Theme
  /** See `AppSettings.hideSecretsInResponses`. */
  hideSecretsInResponses?: boolean
  updates?: Partial<UpdatesSettings>
  /** Replace the TLS scope settings wholesale (callers compose the new value). */
  tls?: TlsScopeSettings
  /** Replace the activity-panel UI prefs wholesale. */
  activityPanel?: ActivityPanelSettings
  /**
   * Replace the palette preferences wholesale. Typed like `AppSettings`'s raw
   * field; the appearance handler is the one writer and passes a normalized
   * `AppearancePalettes`.
   */
  appearancePalettes?: AppearancePalettes | unknown
}

/**
 * Like `writeAppSettings`, but a failed write throws instead of being logged.
 * For changes whose failure the user must see (appearance changes surface it
 * inline with a retry) rather than silently lose.
 */
export function writeAppSettingsStrict(partial: AppSettingsPatch): AppSettings {
  const updated = mergePatch(partial)
  atomicWriteFileSync(SETTINGS_FILE, JSON.stringify(updated, null, 2))
  return updated
}

export function writeAppSettings(partial: AppSettingsPatch): AppSettings {
  const updated = mergePatch(partial)
  try {
    atomicWriteFileSync(SETTINGS_FILE, JSON.stringify(updated, null, 2))
  } catch (err) {
    console.error('[appsettings] Failed to write:', err)
  }
  return updated
}

function mergePatch(partial: AppSettingsPatch): AppSettings {
  const current = readAppSettings()
  const nextActivityPanel: ActivityPanelSettings | undefined =
    partial.activityPanel !== undefined ? partial.activityPanel : current.activityPanel
  const updated: AppSettings = {
    ...current,
    ...partial,
    proxy: { ...current.proxy, ...(partial.proxy ?? {}) },
    updates: { ...current.updates, ...(partial.updates ?? {}) },
    ...(partial.tls !== undefined ? { tls: partial.tls } : current.tls ? { tls: current.tls } : {}),
    ...(nextActivityPanel !== undefined ? { activityPanel: nextActivityPanel } : {})
  }
  return updated
}

function clampIntervalDays(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_UPDATES_SETTINGS.intervalDays
  return Math.min(INTERVAL_DAYS_MAX, Math.max(INTERVAL_DAYS_MIN, Math.round(value)))
}

function sanitizeUpdates(partial: Partial<UpdatesSettings>): Partial<UpdatesSettings> {
  const out: Partial<UpdatesSettings> = {}
  if (partial.intervalDays !== undefined) {
    out.intervalDays = clampIntervalDays(partial.intervalDays)
  }
  if (partial.autoCheckEnabled !== undefined) {
    out.autoCheckEnabled = !!partial.autoCheckEnabled
  }
  if (partial.lastCheckAt !== undefined) {
    out.lastCheckAt =
      partial.lastCheckAt === null || typeof partial.lastCheckAt === 'string'
        ? partial.lastCheckAt
        : null
  }
  return out
}

export function registerAppSettingsHandlers(): void {
  ipcMain.handle('appSettings:get', (): AppSettings => readAppSettings())
  ipcMain.handle('appSettings:set', (_event, partial: AppSettingsPatch): AppSettings =>
    writeAppSettings(partial)
  )
  ipcMain.handle('appSettings:getUpdates', (): UpdatesSettings => readAppSettings().updates)
  ipcMain.handle(
    'appSettings:setUpdates',
    (_event, partial: Partial<UpdatesSettings>): UpdatesSettings => {
      const sanitized = sanitizeUpdates(partial ?? {})
      const updated = writeAppSettings({ updates: sanitized })
      return updated.updates
    }
  )
}
