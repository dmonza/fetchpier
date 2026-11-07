import { useEffect } from 'react'
import { selectDisplayedTheme, useThemeStore } from '../stores/theme'
import { useAppearanceStore } from '../stores/appearance'
import {
  applyResolvedTheme,
  onPlatformThemeChange,
  resolvePlatformTheme,
  type ResolvedTheme
} from '../lib/platform-theme'
import { createFrameApplier } from '../lib/palette-dom'
import type { PaletteTokens } from '../../shared/types'

interface ThemeProviderProps {
  children: React.ReactNode
}

export function ThemeProvider({ children }: ThemeProviderProps): React.JSX.Element {
  const setResolvedTheme = useThemeStore((s) => s.setResolvedTheme)
  const hydrateTheme = useThemeStore((s) => s.hydrateTheme)

  // Follow the platform's resolved theme. Main resolved the user's preference
  // into it before this window existed, so there is nothing to decide here —
  // only to keep following, which covers an OS-level change while the
  // preference is `system` as well as the user picking a different theme.
  // The first application happens at the entry point, before React renders.
  useEffect(() => {
    setResolvedTheme(resolvePlatformTheme())
    return onPlatformThemeChange((resolved) => setResolvedTheme(resolved))
  }, [setResolvedTheme])

  // What this window displays: the mode (a preview when there is one) and that
  // mode's palette (the live draft while editing, else what is in force). A
  // mode switch applies class and palette in the same frame; draft updates
  // during a drag are batched to one per frame.
  useEffect(() => {
    const schedule = createFrameApplier()
    let lastMode: ResolvedTheme | null = null
    let lastTokens: PaletteTokens | null | undefined
    const sync = (): void => {
      const displayed = selectDisplayedTheme(useThemeStore.getState())
      const { drafts, palettes, displayOverride } = useAppearanceStore.getState()
      const draft = drafts[displayed]
      // A live draft wins; then a palette shown in place of the effective one
      // (Settings → Appearance on a mode the workspace overrides); then the
      // effective palette in force.
      const tokens =
        draft !== undefined
          ? draft
          : displayOverride && displayOverride.mode === displayed
            ? displayOverride.tokens
            : palettes[displayed]
      if (displayed !== lastMode) {
        lastMode = displayed
        lastTokens = tokens
        applyResolvedTheme(displayed)
        schedule.now(tokens)
      } else if (tokens !== lastTokens) {
        lastTokens = tokens
        schedule(tokens)
      }
    }
    sync()
    const offTheme = useThemeStore.subscribe(sync)
    const offAppearance = useAppearanceStore.subscribe(sync)
    const offChanged = window.api.appearance.onChanged((state) =>
      useAppearanceStore.getState().applyExternal(state)
    )
    void useAppearanceStore.getState().load()
    return () => {
      offTheme()
      offAppearance()
      offChanged()
    }
  }, [])

  // The preference itself drives only the theme picker's own state; the
  // visible theme is already correct by the time this resolves.
  useEffect(() => {
    window.api.appSettings
      .get()
      .then((settings) => hydrateTheme(settings.theme))
      .catch(() => undefined)
  }, [hydrateTheme])

  return <>{children}</>
}
