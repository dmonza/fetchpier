import { useEffect } from 'react'
import { useThemeStore } from '../stores/theme'
import {
  applyPlatformTheme,
  applyResolvedTheme,
  onPlatformThemeChange
} from '../lib/platform-theme'

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
    setResolvedTheme(applyPlatformTheme())
    return onPlatformThemeChange((resolved) => setResolvedTheme(applyResolvedTheme(resolved)))
  }, [setResolvedTheme])

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
