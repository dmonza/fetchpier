import { create } from 'zustand'
import type { Theme } from '../../shared/types'
import { resolvePlatformTheme, type ResolvedTheme } from '../lib/platform-theme'

interface ThemeState {
  /** User-selected theme preference */
  theme: Theme
  /** Resolved theme (never 'system') — the mode in force, decided by the platform signal */
  resolvedTheme: ResolvedTheme
  /**
   * A mode shown in this window as a preview only (while its Appearance
   * sub-tab is selected). Never persisted, never sent to main.
   */
  previewTheme: ResolvedTheme | null
  setTheme: (theme: Theme) => void
  /** Adopt the stored preference without echoing it back to the main process. */
  hydrateTheme: (theme: Theme) => void
  setResolvedTheme: (resolved: ResolvedTheme) => void
  setPreviewTheme: (preview: ResolvedTheme | null) => void
}

/** What this window shows: the preview when there is one, else the mode in force. */
export const selectDisplayedTheme = (
  s: Pick<ThemeState, 'previewTheme' | 'resolvedTheme'>
): ResolvedTheme => s.previewTheme ?? s.resolvedTheme

/**
 * The preference is persisted in app-global settings, not here: the process
 * that creates windows has to read it before any window exists, and it cannot
 * reach renderer-local storage. This store holds the session's view of it.
 */
export const useThemeStore = create<ThemeState>()((set) => ({
  theme: 'system',
  resolvedTheme: resolvePlatformTheme(),
  previewTheme: null,
  setTheme: (theme) => {
    set({ theme })
    // Main applies it to the platform and persists it. `resolvedTheme` is not
    // set here — it follows from the platform signal, so the one path that
    // decides the visible theme stays the same whether the change came from
    // the user or from the OS.
    void window.api.theme.setNativeTheme(theme)
  },
  hydrateTheme: (theme) => set({ theme }),
  setResolvedTheme: (resolvedTheme) => set({ resolvedTheme }),
  setPreviewTheme: (previewTheme) => set({ previewTheme })
}))
