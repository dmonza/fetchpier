// IntelliSense UX helpers for the Fetchpier script editor (REQ-43).
//
// Pure functions + small stateful trackers that complement the TypeScript
// LanguageService completion source. Kept in their own module so they are
// trivial to unit-test in isolation from CodeMirror / EditorView plumbing.

import type { EditorView, Command } from '@codemirror/view'
import {
  acceptCompletion,
  selectedCompletion,
  completionStatus,
  startCompletion,
  type Completion
} from '@codemirror/autocomplete'

// ── Kind → icon ─────────────────────────────────────────────────────────────

/**
 * Map a TypeScript `ScriptElementKind` string to the CodeMirror completion
 * icon name. CM6 creates the class `cm-completionIcon-{type}` from whatever
 * we return, so the built-in icon CSS for `method`, `property`, `variable`,
 * etc. applies automatically.
 *
 * If the entry is deprecated (per its `kindModifiers`), we append `deprecated`
 * as a second token so CM6 generates `cm-completionIcon-method-deprecated`
 * **and** `cm-completionIcon-deprecated`, which our CSS uses to paint the
 * strikethrough.
 */
export function scriptKindToIcon(kind: string, modifiers: string = ''): string | undefined {
  const base = baseIconFor(kind)
  if (!base) return isDeprecated(modifiers) ? 'deprecated' : undefined
  return isDeprecated(modifiers) ? `${base} deprecated` : base
}

function baseIconFor(kind: string): string | undefined {
  switch (kind) {
    // Functions & methods
    case 'method':
    case 'getter':
    case 'setter':
      return 'method'
    case 'function':
    case 'local function':
    case 'call':
    case 'construct':
      return 'function'
    case 'constructor':
      return 'method'

    // Data / members
    case 'property':
    case 'accessor':
    case 'index':
      return 'property'
    case 'var':
    case 'local var':
    case 'let':
    case 'using':
    case 'await using':
      return 'variable'
    case 'const':
      return 'constant'
    case 'parameter':
      return 'variable'

    // Types & structures
    case 'class':
    case 'local class':
      return 'class'
    case 'interface':
      return 'interface'
    case 'type':
    case 'type parameter':
    case 'primitive type':
      return 'type'
    case 'enum':
      return 'enum'
    case 'enum member':
      return 'constant'
    case 'module':
    case 'external module name':
      return 'namespace'

    // Misc
    case 'alias':
      return 'variable'
    case 'keyword':
      return 'keyword'
    case 'string':
      return 'text'
    case 'label':
      return 'text'

    default:
      return undefined
  }
}

/** True if a TS `kindModifiers` string marks the entry as deprecated. */
export function isDeprecated(modifiers: string): boolean {
  if (!modifiers) return false
  return modifiers.split(/[,\s]+/).some((m) => m === 'deprecated')
}

// ── Kind → commit characters ────────────────────────────────────────────────

const METHOD_LIKE: readonly string[] = ['.', '(']
const VALUE_LIKE: readonly string[] = ['.', ',', ';']
const TYPE_LIKE: readonly string[] = ['.']
const KEYWORD_LIKE: readonly string[] = [' ']
const NONE: readonly string[] = []

/**
 * Return the commit characters appropriate for an autocomplete entry of the
 * given TypeScript `kind`. Typing one of these with a completion selected
 * inserts the completion, then the character.
 */
export function commitCharactersFor(kind: string): readonly string[] {
  switch (kind) {
    // Callables
    case 'method':
    case 'function':
    case 'local function':
    case 'constructor':
    case 'call':
    case 'construct':
    case 'getter':
    case 'setter':
      return METHOD_LIKE

    // Value-ish references
    case 'property':
    case 'accessor':
    case 'index':
    case 'var':
    case 'local var':
    case 'let':
    case 'const':
    case 'using':
    case 'await using':
    case 'parameter':
    case 'alias':
    case 'enum member':
      return VALUE_LIKE

    // Containers (expected to be followed by `.`)
    case 'module':
    case 'external module name':
    case 'class':
    case 'local class':
    case 'interface':
    case 'enum':
    case 'type':
    case 'type parameter':
    case 'primitive type':
      return TYPE_LIKE

    case 'keyword':
      return KEYWORD_LIKE

    default:
      return NONE
  }
}

// ── Recently-used tracker ───────────────────────────────────────────────────

export interface RecentlyUsedTracker {
  /** Record that `label` was accepted for the (case-insensitive) prefix. */
  record(prefix: string, label: string): void
  /**
   * Comparator for two completions against the current `prefix`. Returns a
   * negative number if `a` should sort before `b`, positive if after, 0
   * otherwise. Only breaks ties for exact recent-use matches; leaves the
   * fuzzy-match scoring untouched in the general case.
   */
  compare(a: Completion, b: Completion, prefix: string): number
}

/** Create a new in-memory tracker, scoped to one editor instance. */
export function createRecentlyUsedTracker(): RecentlyUsedTracker {
  const map = new Map<string, { label: string; at: number }>()

  return {
    record(prefix, label) {
      map.set(normalise(prefix), { label, at: Date.now() })
    },
    compare(a, b, prefix) {
      const hit = map.get(normalise(prefix))
      if (!hit) return 0
      if (a.label === hit.label && b.label !== hit.label) return -1
      if (b.label === hit.label && a.label !== hit.label) return 1
      return 0
    }
  }
}

function normalise(prefix: string): string {
  return prefix.toLowerCase()
}

// ── Enter-smart ────────────────────────────────────────────────────────────

/**
 * A CodeMirror `Command` that behaves like `acceptCompletion` **unless** the
 * currently-selected completion would just reinsert the prefix the user has
 * already typed. In that case it returns `false`, letting the default Enter
 * handler insert a newline instead.
 *
 * Mirrors VS Code's `editor.acceptSuggestionOnEnter: 'smart'` default.
 */
export const acceptIfSmart: Command = (view: EditorView) => {
  if (completionStatus(view.state) !== 'active') return false
  const selected = selectedCompletion(view.state)
  if (!selected) return false
  const prefix = prefixUnderCursor(view)
  if (prefix.length > 0 && labelEqualsPrefix(selected.label, prefix)) {
    return false
  }
  return acceptCompletion(view)
}

function prefixUnderCursor(view: EditorView): string {
  const state = view.state
  const pos = state.selection.main.head
  const line = state.doc.lineAt(pos)
  const before = state.doc.sliceString(line.from, pos)
  const match = /[\w$]*$/.exec(before)
  return match ? match[0] : ''
}

function labelEqualsPrefix(label: string, prefix: string): boolean {
  return label.toLowerCase() === prefix.toLowerCase()
}

// ── Auto-trigger signature help ─────────────────────────────────────────────

/**
 * Build a `Completion.apply` for entries that represent callables (methods,
 * functions, constructors). When the user accepts the entry:
 *   1. Replaces the completion range with `{label}(`.
 *   2. Places the caret between the parentheses.
 *   3. Reopens the completion popup so the next suggestions (parameter-aware
 *      when TS can infer them) appear immediately.
 *
 * Proper signature help tooltips (`getSignatureHelpItems`) are not yet wired
 * through `@valtown/codemirror-ts`; the popup reopen is the best approximation
 * available without that adapter.
 */
export function makeAutoTriggerApply(
  label: string
): (view: EditorView, completion: Completion, from: number, to: number) => void {
  return (view, _completion, from, to) => {
    const insert = `${label}()`
    const cursor = from + label.length + 1
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: cursor }
    })
    // Reopen the popup after the dispatch settles so completion state is
    // based on the post-insertion document.
    const raf = typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame : null
    const reopen = (): void => {
      startCompletion(view)
    }
    if (raf) raf(reopen)
    else setTimeout(reopen, 0)
  }
}

/**
 * True if completions of this TS kind should automatically open parentheses
 * and re-trigger the completion popup on accept.
 */
export function shouldAutoTrigger(kind: string): boolean {
  switch (kind) {
    case 'method':
    case 'function':
    case 'local function':
    case 'constructor':
    case 'call':
    case 'construct':
      return true
    default:
      return false
  }
}
