import { useEffect, useRef, useState } from 'react'
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view'
import { EditorState, Compartment, Prec } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { javascript } from '@codemirror/lang-javascript'
import {
  acceptCompletion,
  autocompletion,
  completionStatus,
  completionKeymap,
  pickedCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource
} from '@codemirror/autocomplete'
import { linter, lintGutter } from '@codemirror/lint'
import { useCodeMirrorThemeStore } from '../stores/codemirror-theme'
import { useThemeStore } from '../stores/theme'
import { useAppearanceStore } from '../stores/appearance'
import { resolveThemeExtension, ExternalSync } from './useCodeMirror'
import { getTsEnvironmentFor, SCRIPT_PATH, type ScriptPhase } from './tsLanguageService'
import {
  acceptIfSmart,
  commitCharactersFor,
  createRecentlyUsedTracker,
  isDeprecated,
  makeAutoTriggerApply,
  scriptKindToIcon,
  shouldAutoTrigger,
  type RecentlyUsedTracker
} from './scriptEditorCompletions'

// ── Base structural theme ───────────────────────────────────────────────────

const BASE_THEME = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', backgroundColor: 'transparent' },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace"
  }
})

// ── Keymaps (exported for tests — REQ-44) ───────────────────────────────────

// High-precedence keymap so Tab/Enter win over `indentWithTab` and the
// default `completionKeymap`'s Enter binding, but only when a completion
// popup is currently active.
export const smartCompletionKeymap: Extension = Prec.high(
  keymap.of([
    {
      key: 'Tab',
      run: (view) => {
        if (completionStatus(view.state) !== 'active') return false
        return acceptCompletion(view)
      },
      preventDefault: true
    },
    {
      key: 'Enter',
      run: acceptIfSmart
    }
  ])
)

// High-precedence copy of CM's default `completionKeymap`, minus its Enter
// binding (owned by `smartCompletionKeymap` above). Needs Prec.high so its
// ArrowDown / ArrowUp / PageDown / PageUp / Escape / Ctrl-Space bindings beat
// `defaultKeymap`'s cursor-movement bindings — which otherwise move the caret
// and force CM to close the popup on selection change.
export const completionNavigationKeymap: Extension = Prec.high(
  keymap.of(completionKeymap.filter((binding) => binding.key !== 'Enter'))
)

// Base keymap: default editing + history + Tab→indent. Completion bindings
// are mounted above at Prec.high, so they are not shadowed by `defaultKeymap`.
// We pass `defaultKeymap: false` to the `autocompletion()` call below so CM
// doesn't register its completion bindings a second time.
export const scriptEditorBaseKeymap: Extension = keymap.of([
  ...defaultKeymap,
  ...historyKeymap,
  indentWithTab
])

// ── Hook ────────────────────────────────────────────────────────────────────

interface UseScriptEditorOptions {
  value: string
  onChange: (value: string) => void
  /**
   * The scripting phase. Determines which `.d.ts` is mounted in the VFS so
   * IntelliSense narrows `orc.request` / `orc.response` correctly (REQ-42).
   */
  phase: ScriptPhase
  readOnly?: boolean
}

export interface UseScriptEditorStatus {
  /** True while the lazy TS bundle is still loading. */
  loading: boolean
  /** Non-null when the lazy load failed permanently. */
  error: Error | null
}

const LINTER_DEBOUNCE_MS = 250

export function useScriptEditor(
  containerRef: React.RefObject<HTMLDivElement | null>,
  options: UseScriptEditorOptions
): UseScriptEditorStatus {
  const { value, onChange, phase, readOnly = false } = options

  const themeFamily = useCodeMirrorThemeStore((s) => s.themeFamily)
  // The displayed mode (a preview while one is shown) and its palette in force.
  const resolvedTheme = useThemeStore((s) => s.previewTheme ?? s.resolvedTheme)
  const palette = useAppearanceStore((s) => s.palettes[resolvedTheme])

  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  })

  const viewRef = useRef<EditorView | null>(null)
  const lastExternalValueRef = useRef(value)
  const themeCompartment = useRef(new Compartment())
  const intellisenseCompartment = useRef(new Compartment())

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    if (!containerRef.current) return

    const updateListener = EditorView.updateListener.of((update) => {
      if (!update.docChanged) return
      if (update.transactions.some((tr) => tr.annotation(ExternalSync))) return
      const newValue = update.state.doc.toString()
      lastExternalValueRef.current = newValue
      onChangeRef.current(newValue)
    })

    const recentlyUsed = createRecentlyUsedTracker()

    const extensions: Extension[] = [
      history(),
      smartCompletionKeymap,
      completionNavigationKeymap,
      scriptEditorBaseKeymap,
      lineNumbers(),
      highlightActiveLine(),
      javascript({ typescript: true }),
      lintGutter(),
      // Populated once the TS bundle loads.
      intellisenseCompartment.current.of([
        // While TS is loading, keep an empty autocompletion + linter so the
        // extensions registered don't change shape after the async init.
        autocompletion()
      ]),
      BASE_THEME,
      themeCompartment.current.of(resolveThemeExtension(themeFamily, resolvedTheme, palette)),
      updateListener,
      EditorState.readOnly.of(readOnly),
      EditorView.lineWrapping
    ]

    const state = EditorState.create({ doc: value, extensions })
    const view = new EditorView({ state, parent: containerRef.current })
    viewRef.current = view

    // Hook onto transactions so we can record "recently used" whenever a
    // completion is actually picked (Tab, Enter, click, or commit char).
    const recentlyUsedObserver = EditorView.updateListener.of((update) => {
      for (const tr of update.transactions) {
        const picked = tr.annotation(pickedCompletion)
        if (!picked) continue
        const prefixBefore = prefixEndingAt(
          tr.startState.doc.sliceString(0, tr.startState.selection.main.head)
        )
        recentlyUsed.record(prefixBefore, picked.label)
      }
    })

    let cancelled = false

    // The per-phase TS environment is shared and long-lived; this editor's
    // working file must be removed from it on teardown, or leftover files from
    // prior editor sessions collide in the shared global scope (false
    // `Cannot redeclare …` diagnostics + stale completions). REQ-0093.
    // Captured here (not just inside the async IIFE) so the cleanup below — a
    // closure created in this same effect run — can dispose it. Stays `null` if
    // the editor is torn down before init registers the file.
    let instanceFile: {
      env: Awaited<ReturnType<typeof getTsEnvironmentFor>>['env']
      path: string
    } | null = null

    void (async () => {
      try {
        const [{ env }, cmts] = await Promise.all([
          getTsEnvironmentFor(phase),
          import('@valtown/codemirror-ts')
        ])
        if (cancelled) return

        // Each editor instance owns a unique path in the shared VFS so
        // completions/diagnostics don't collide if multiple script editors
        // are mounted simultaneously (ScriptsEditor has one per phase).
        const instancePath = `${SCRIPT_PATH.replace(
          /\.ts$/,
          ''
        )}-${Math.random().toString(36).slice(2)}.ts`
        env.createFile(instancePath, view.state.doc.toString() || ' ')
        instanceFile = { env, path: instancePath }

        const tsCompletionSource = createTsCompletionSource({
          env,
          path: instancePath,
          recentlyUsed
        })

        const tsExtensions: Extension[] = [
          cmts.tsFacet.of({ env, path: instancePath }),
          cmts.tsSync(),
          cmts.tsHover(),
          linter(
            async () => cmts.getLints({ env, path: instancePath, diagnosticCodesToIgnore: [] }),
            { delay: LINTER_DEBOUNCE_MS }
          ),
          autocompletion({
            override: [tsCompletionSource],
            defaultKeymap: false, // we own Tab/Enter via smartCompletionKeymap
            activateOnTyping: true
          }),
          recentlyUsedObserver
        ]

        view.dispatch({
          effects: intellisenseCompartment.current.reconfigure(tsExtensions)
        })
        setLoading(false)
      } catch (err) {
        if (cancelled) return
        setError(err as Error)
        setLoading(false)
      }
    })()

    return () => {
      cancelled = true
      view.destroy()
      viewRef.current = null
      // Remove this editor's working file from the shared per-phase env so it
      // can't leak into the next editor of this phase (REQ-0093). No-op when
      // init was cancelled before the file was registered.
      if (instanceFile) {
        instanceFile.env.deleteFile(instanceFile.path)
        instanceFile = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: themeCompartment.current.reconfigure(
        resolveThemeExtension(themeFamily, resolvedTheme, palette)
      )
    })
  }, [themeFamily, resolvedTheme, palette])

  return { loading, error }
}

// ── Completion source ──────────────────────────────────────────────────────

interface TsCompletionSourceDeps {
  env: Awaited<ReturnType<typeof getTsEnvironmentFor>>['env']
  path: string
  recentlyUsed: RecentlyUsedTracker
}

const COMPLETE_BLOCKLIST = new Set<string>(['warning'])

function createTsCompletionSource(deps: TsCompletionSourceDeps): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const { env, path, recentlyUsed } = deps
    const { pos, explicit } = context

    // Decide what's being replaced. Match a word before the cursor, or the
    // dot if the user just typed one.
    let word = context.matchBefore(/[\w$]*/)
    if (!word || (word.from === word.to && !explicit)) {
      // Check for a trigger dot as fallback.
      const dot = context.matchBefore(/\./)
      if (!dot) return null
      word = dot
    }

    if (!env.getSourceFile(path)) return null

    const info = env.languageService.getCompletionsAtPosition(path, pos, {})
    if (!info) return null

    const from = word.text === '.' ? word.to : word.from
    const prefix = word.text === '.' ? '' : word.text

    const options: Completion[] = []
    for (const entry of info.entries) {
      if (COMPLETE_BLOCKLIST.has(entry.kind)) continue
      const boost = -Number(entry.sortText) || 0
      const type = scriptKindToIcon(entry.kind, entry.kindModifiers)
      const commitCharacters = commitCharactersFor(entry.kind)
      const deprecated = isDeprecated(entry.kindModifiers || '')
      const completion: Completion = {
        label: entry.name,
        type,
        boost,
        commitCharacters,
        sortText: entry.sortText,
        info: makeLazyInfo({ env, path, pos, entry, deprecated })
      }
      if (shouldAutoTrigger(entry.kind)) {
        completion.apply = makeAutoTriggerApply(entry.name)
      }
      options.push(completion)
    }

    // Apply recently-used promotion on top of the default CM ranking.
    options.sort((a, b) => recentlyUsed.compare(a, b, prefix))

    return { from, options }
  }
}

interface LazyInfoDeps {
  env: Awaited<ReturnType<typeof getTsEnvironmentFor>>['env']
  path: string
  pos: number
  entry: import('typescript').CompletionEntry
  deprecated: boolean
}

function makeLazyInfo(deps: LazyInfoDeps): (completion: Completion) => Promise<Node | null> {
  return async (_completion) => {
    const { env, path, pos, entry, deprecated } = deps
    const details = env.languageService.getCompletionEntryDetails(
      path,
      pos,
      entry.name,
      undefined,
      entry.source,
      undefined,
      entry.data
    )
    if (!details) return null

    const dom = document.createElement('div')
    dom.className = 'cm-completionInfo-orc'

    const signature = details.displayParts?.map((p) => p.text).join('') ?? ''
    const documentation = details.documentation?.map((p) => p.text).join('') ?? ''

    if (signature) {
      const sigEl = document.createElement('div')
      sigEl.className = 'cm-completionInfo-signature'
      sigEl.textContent = signature
      dom.appendChild(sigEl)
    }
    if (deprecated) {
      const dep = document.createElement('div')
      dep.className = 'cm-completionInfo-deprecated'
      dep.textContent = '@deprecated'
      dom.appendChild(dep)
    }
    if (documentation) {
      const docEl = document.createElement('div')
      docEl.className = 'cm-completionInfo-docs'
      docEl.textContent = documentation
      dom.appendChild(docEl)
    }
    return dom
  }
}

function prefixEndingAt(textBeforeCursor: string): string {
  const match = /[\w$]*$/.exec(textBeforeCursor)
  return match ? match[0] : ''
}
