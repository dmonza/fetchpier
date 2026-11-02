/**
 * CodeMirror binding for the canonical variable editing behavior (REQ-0078).
 *
 * Mirrors what `VariableHighlightInput` does for plain inputs, but for the raw
 * body editor: `{{...}}` highlighting + a `{{`-triggered suggestion over the
 * active environment's declared variable names with idempotent `{{name}}`
 * completion. Both surfaces share the pure helpers in `lib/variables-editing.ts`
 * so the behavior is defined once.
 *
 * The `fp.*` script completion never appears here, and this `{{` completion
 * never appears in the script editor — they are wired by separate hooks.
 */

import {
  EditorView,
  Decoration,
  ViewPlugin,
  MatchDecorator,
  keymap,
  type DecorationSet,
  type ViewUpdate
} from '@codemirror/view'
import { Prec, type Extension } from '@codemirror/state'
import {
  autocompletion,
  completionKeymap,
  pickedCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult
} from '@codemirror/autocomplete'
import {
  buildVariableSuggestions,
  filterVariableSuggestions,
  computeVariableCompletion,
  type VariableSuggestion
} from '../lib/variables-editing'
import { isDynamicVariableName } from '@shared/lib/dynamic-variables'

const VARIABLE_RE = /\{\{([^{}]+)\}\}/g

/**
 * Decorates every `{{name}}` placeholder in one of three states (REQ-0087):
 *  - `cm-fp-var-dynamic` — a recognized system dynamic variable (`{{$guid}}`);
 *  - `cm-fp-var`         — resolved: the name is declared in the active environment;
 *  - `cm-fp-var-missing` — unresolved: an unknown name (incl. an unknown `$`-token).
 */
function variableHighlighter(known: Set<string>): Extension {
  const matcher = new MatchDecorator({
    regexp: VARIABLE_RE,
    decoration: (match) => {
      const name = match[1].trim()
      const cls = isDynamicVariableName(name)
        ? 'cm-fp-var cm-fp-var-dynamic'
        : known.has(name)
          ? 'cm-fp-var'
          : 'cm-fp-var cm-fp-var-missing'
      return Decoration.mark({ class: cls })
    }
  })
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = matcher.createDeco(view)
      }
      update(update: ViewUpdate): void {
        this.decorations = matcher.updateDeco(update, this.decorations)
      }
    },
    { decorations: (v) => v.decorations }
  )
}

/**
 * Completion source: when the caret is inside an open `{{`, offer the declared
 * variable names. The replacement anchor is set right after the `{{` so the
 * partial name drives the default fuzzy filter; on accept, the whole `{{…}}` is
 * rewritten to exactly `{{name}}` (idempotent against an already-present `}}`).
 */
export function variableCompletionSource(
  suggestions: VariableSuggestion[]
): (context: CompletionContext) => CompletionResult | null {
  return (context) => {
    if (suggestions.length === 0) return null
    const match = context.matchBefore(/\{\{[^}]*$/)
    if (!match) return null

    const partial = match.text.slice(2) // text after the `{{`
    const filtered = filterVariableSuggestions(suggestions, partial)
    if (filtered.length === 0) return null

    const options: Completion[] = filtered.map((s) => ({
      label: s.name,
      type: s.isDynamic ? 'dynamic' : s.isSecret ? 'secret' : 'variable',
      apply: (view, completion, from, to) => {
        // `from` sits right after the `{{`; extend back to include it so the
        // result is exactly `{{name}}`, consuming any closing `}}` already there.
        const after = view.state.sliceDoc(to, to + 2)
        const { insert, consume } = computeVariableCompletion(s.name, after)
        const braceStart = from - 2
        view.dispatch({
          changes: { from: braceStart, to: to + consume, insert },
          selection: { anchor: braceStart + insert.length },
          annotations: pickedCompletion.of(completion)
        })
      }
    }))

    // `filter: false` — the source already filters via `filterVariableSuggestions`,
    // so disable CodeMirror's own re-filter/re-sort. This makes CM preserve the
    // order of `options` (env names first, then dynamic variables — and the env
    // names in the manager's order) instead of re-sorting alphabetically, which
    // would float `$`-prefixed dynamic names above the environment names.
    return { from: match.from + 2, options, filter: false }
  }
}

/**
 * The full set of extensions that bind a CodeMirror editor to the variable
 * editing behavior for the given active-environment variables. Empty when there
 * are no variables to offer (the highlighter still renders unknown placeholders
 * literally, which is the same as no decoration).
 */
export function variableEditorExtensions(variables: Record<string, string | null>): Extension {
  const suggestions = buildVariableSuggestions(variables)
  const known = new Set(suggestions.map((s) => s.name))
  return [
    variableHighlighter(known),
    // Completion bindings at high precedence so Enter/arrows/Escape beat the base
    // keymap while the popup is active; they no-op (and fall through to newline)
    // when no completion is active.
    Prec.high(keymap.of(completionKeymap)),
    autocompletion({
      override: [variableCompletionSource(suggestions)],
      defaultKeymap: false,
      activateOnTyping: true
    })
  ]
}
