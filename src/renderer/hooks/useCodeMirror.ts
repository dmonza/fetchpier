import { useEffect, useRef } from 'react'
import { EditorView, keymap, lineNumbers, highlightActiveLine, tooltips } from '@codemirror/view'
import { EditorState, Compartment, Annotation } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { json } from '@codemirror/lang-json'
import { html } from '@codemirror/lang-html'
import { xml } from '@codemirror/lang-xml'
import { javascript } from '@codemirror/lang-javascript'
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { oneDark } from '@codemirror/theme-one-dark'
import { githubLight, githubDark } from '@uiw/codemirror-theme-github'
import { dracula } from '@uiw/codemirror-theme-dracula'
import { useCodeMirrorThemeStore } from '../stores/codemirror-theme'
import type { CodeMirrorThemeFamily } from '../stores/codemirror-theme'
import { useThemeStore } from '../stores/theme'
import { variableEditorExtensions } from './variableEditorExtension'

export type CodeMirrorLanguage = 'json' | 'html' | 'xml' | 'javascript' | 'text'

// Marks a transaction that only syncs the editor doc to a new external `value`
// prop. The `updateListener` skips these so `onChange` doesn't fire — switching
// request tabs reuses the same editor instance, and without this guard the doc
// sync would look like a user edit and mark the request dirty.
export const ExternalSync = Annotation.define<boolean>()

// ── Base structural theme (always applied, no colors) ────────────────────────

const BASE_THEME = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', backgroundColor: 'transparent' },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace"
  }
})

// ── Default color theme: CSS variables — follows the app's light/dark mode ───

const DEFAULT_COLORS: Extension = [
  EditorView.theme({
    '.cm-content': { caretColor: 'var(--foreground)', color: 'var(--foreground)' },
    '.cm-gutters': {
      backgroundColor: 'var(--muted)',
      color: 'var(--muted-foreground)',
      borderRight: '1px solid var(--border)'
    },
    '.cm-activeLine': { backgroundColor: 'var(--accent)' },
    '.cm-activeLineGutter': { backgroundColor: 'var(--accent)' },
    '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--accent) !important' },
    '.cm-cursor': { borderLeftColor: 'var(--foreground)' }
  }),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true })
]

// ── Theme resolver — picks the right variant based on resolved light/dark ────

export function resolveThemeExtension(
  family: CodeMirrorThemeFamily,
  resolvedTheme: 'light' | 'dark'
): Extension {
  const isDark = resolvedTheme === 'dark'
  switch (family) {
    case 'github':
      return isDark ? githubDark : githubLight
    case 'one-dark':
      // One Dark has no official light variant — fall back to the default auto theme
      return isDark ? oneDark : DEFAULT_COLORS
    case 'dracula':
      // Dracula has no official light variant — fall back to the default auto theme
      return isDark ? dracula : DEFAULT_COLORS
    default:
      return DEFAULT_COLORS
  }
}

// ── Hook ─────────────────────────────────────────────────────────────────────

interface UseCodeMirrorOptions {
  value: string
  language?: CodeMirrorLanguage
  onChange: (value: string) => void
  readOnly?: boolean
  /**
   * Active environment variables (the unified shape-classified map). When
   * provided, the editor binds to the canonical variable editing behavior
   * (REQ-0078): `{{...}}` highlighting + `{{`-triggered suggestion over the
   * declared names (plain + secret, by name only) with idempotent completion.
   */
  variables?: Record<string, string | null>
}

/**
 * Mounts a CodeMirror 6 editor inside the given container ref.
 * Dynamically reconfigures the color theme when the user changes the theme
 * family in Settings or when the app switches between light and dark mode.
 */
export function useCodeMirror(
  containerRef: React.RefObject<HTMLDivElement | null>,
  options: UseCodeMirrorOptions
): void {
  const { value, language = 'text', onChange, readOnly = false, variables } = options

  const themeFamily = useCodeMirrorThemeStore((s) => s.themeFamily)
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme)

  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  })

  const viewRef = useRef<EditorView | null>(null)
  const lastExternalValueRef = useRef(value)
  // One Compartment per editor instance — allows dynamic theme reconfiguration
  const themeCompartment = useRef(new Compartment())
  // Holds the variable editing behavior (REQ-0078); reconfigured when the active
  // environment's variables change, without remounting the editor.
  const varCompartment = useRef(new Compartment())

  // Create the editor once on mount; re-create when language changes
  useEffect(() => {
    if (!containerRef.current) return

    const languageExtension =
      language === 'json'
        ? json()
        : language === 'html'
          ? html()
          : language === 'xml'
            ? xml()
            : language === 'javascript'
              ? javascript()
              : []

    const updateListener = EditorView.updateListener.of((update) => {
      if (!update.docChanged) return
      if (update.transactions.some((tr) => tr.annotation(ExternalSync))) return
      const newValue = update.state.doc.toString()
      lastExternalValueRef.current = newValue
      onChangeRef.current(newValue)
    })

    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        lineNumbers(),
        highlightActiveLine(),
        languageExtension,
        varCompartment.current.of(variables ? variableEditorExtensions(variables) : []),
        // Render tooltips (incl. the `{{` variable autocomplete) with fixed
        // positioning so they escape the `overflow: hidden` of the editor's
        // ancestors (RequestEditor / BodyEditor / the resizable panes) instead of
        // being clipped or hidden behind the response panel.
        tooltips({ position: 'fixed' }),
        BASE_THEME,
        themeCompartment.current.of(resolveThemeExtension(themeFamily, resolvedTheme)),
        updateListener,
        EditorState.readOnly.of(readOnly),
        EditorView.lineWrapping
      ]
    })

    const view = new EditorView({ state, parent: containerRef.current })
    viewRef.current = view

    return () => {
      view.destroy()
      viewRef.current = null
    }
    // Intentionally only re-create when language changes — theme is handled via Compartment
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language])

  // Sync external value changes without triggering onChange
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === value || lastExternalValueRef.current === value) return
    lastExternalValueRef.current = value
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      annotations: ExternalSync.of(true)
    })
  }, [value])

  // Reconfigure theme when family or resolved light/dark mode changes
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: themeCompartment.current.reconfigure(
        resolveThemeExtension(themeFamily, resolvedTheme)
      )
    })
  }, [themeFamily, resolvedTheme])

  // Reconfigure the variable editing behavior when the active environment's
  // variables change (env switch or variable edit), without remounting.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: varCompartment.current.reconfigure(
        variables ? variableEditorExtensions(variables) : []
      )
    })
  }, [variables])
}
