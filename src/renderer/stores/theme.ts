import { create } from 'zustand'
import type { Theme } from '../../shared/types'
import { resolvePlatformTheme, type ResolvedTheme } from '../lib/platform-theme'

interface ThemeState {
  /** User-selected theme preference */
  theme: Theme
  /** Resolved theme (never 'system') — what actually gets applied to the DOM */
  resolvedTheme: ResolvedTheme
  setTheme: (theme: Theme) => void
  /** Adopt the stored preference without echoing it back to the main process. */
  hydrateTheme: (theme: Theme) => void
  setResolvedTheme: (resolved: ResolvedTheme) => void
}

/**
 * The preference is persisted in app-global settings, not here: the process
 * that creates windows has to read it before any window exists, and it cannot
 * reach renderer-local storage. This store holds the session's view of it.
 */
export const useThemeStore = create<ThemeState>()((set) => ({
  theme: 'system',
  resolvedTheme: resolvePlatformTheme(),
  setTheme: (theme) => {
    set({ theme })
    // Main applies it to the platform and persists it. `resolvedTheme` is not
    // set here — it follows from the platform signal, so the one path that
    // decides the visible theme stays the same whether the change came from
    // the user or from the OS.
    void window.api.theme.setNativeTheme(theme)
  },
  hydrateTheme: (theme) => set({ theme }),
  setResolvedTheme: (resolvedTheme) => set({ resolvedTheme })
}))
