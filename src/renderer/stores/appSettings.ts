import { create } from 'zustand'
import type { UpdatesSettings } from '../../shared/types'
import { DEFAULT_UPDATES_SETTINGS } from '../../shared/types'

interface AppSettingsState {
  updates: UpdatesSettings
  isLoaded: boolean

  loadUpdates: () => Promise<UpdatesSettings>
  setUpdates: (partial: Partial<UpdatesSettings>) => Promise<UpdatesSettings>
  stampLastVersion: (currentVersion: string) => Promise<void>
}

export const useAppSettingsStore = create<AppSettingsState>()((set) => ({
  updates: { ...DEFAULT_UPDATES_SETTINGS },
  isLoaded: false,

  loadUpdates: async () => {
    const next = await window.api.appSettings.getUpdates()
    set({ updates: next, isLoaded: true })
    return next
  },

  setUpdates: async (partial) => {
    const next = await window.api.appSettings.setUpdates(partial)
    set({ updates: next, isLoaded: true })
    return next
  },

  /**
   * Record that the About was shown for `currentVersion`, so it does not open
   * again until the next version change. Called every time the dialog is
   * shown; when the stored version already matches, nothing is written — a
   * manual open never touches the settings file.
   *
   * A failure to read or write is logged and swallowed: the About is showing
   * either way, and the worst case is that it opens once more next launch.
   */
  stampLastVersion: async (currentVersion) => {
    try {
      const settings = await window.api.appSettings.get()
      if (settings.lastVersion === currentVersion) return
      await window.api.appSettings.set({ lastVersion: currentVersion })
    } catch (err) {
      console.error('[appSettings] Failed to stamp lastVersion:', err)
    }
  }
}))

/**
 * Pure helper (unit-testable) that decides whether the updates panel should
 * auto-open based on the last check timestamp and the interval in days.
 */
export function shouldAutoOpenUpdates(settings: UpdatesSettings, nowMs: number): boolean {
  if (!settings.autoCheckEnabled) return false
  if (settings.lastCheckAt === null) return true
  const last = Date.parse(settings.lastCheckAt)
  if (Number.isNaN(last)) return true
  const elapsedMs = nowMs - last
  const intervalMs = settings.intervalDays * 24 * 60 * 60 * 1000
  return elapsedMs >= intervalMs
}
