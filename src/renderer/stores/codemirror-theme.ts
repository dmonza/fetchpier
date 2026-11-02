import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * Theme family — no variant info. The actual light/dark extension is resolved
 * at runtime based on the app's resolvedTheme (light | dark).
 *
 * Pairs:
 *   default   → CSS variables (always auto-adapts, no named theme needed)
 *   github    → githubLight  / githubDark
 *   one-dark  → Default CSS  / oneDark     (One Dark has no official light variant)
 *   dracula   → Default CSS  / dracula     (Dracula has no official light variant)
 */
export type CodeMirrorThemeFamily = 'default' | 'github' | 'one-dark' | 'dracula'

interface CodeMirrorThemeState {
  themeFamily: CodeMirrorThemeFamily
  setThemeFamily: (family: CodeMirrorThemeFamily) => void
}

// Default: GitHub — has genuine light and dark variants, clean and professional.
// One Dark is the best pure-dark option and is a secondary recommendation.
export const useCodeMirrorThemeStore = create<CodeMirrorThemeState>()(
  persist(
    (set) => ({
      themeFamily: 'github',
      setThemeFamily: (themeFamily) => set({ themeFamily })
    }),
    { name: 'codemirror-theme' }
  )
)
