/**
 * Canonical variable editing behavior (REQ-0078).
 *
 * This is the single, surface-independent definition every bound input surface
 * conforms to: the `{{...}}` highlight, the `{{`-triggered suggestion over the
 * active environment's declared variable names, and the idempotent `{{name}}`
 * completion on selection. Both `VariableHighlightInput` (URL, params, headers,
 * auth, structured bodies) and the CodeMirror base editor (raw bodies) consume
 * these helpers so the behavior cannot drift per surface.
 *
 * The suggestion offers variable **names** only — never a value, for plain or
 * secret variables alike. Secrecy protects the value, never the name (a secret's
 * name is stored in plaintext, committed, and shared). Values stay viewable only
 * in the environment editor.
 */

import { DYNAMIC_VARIABLE_NAMES } from '@shared/lib/dynamic-variables'

/**
 * A variable's secret-ness is derived from its value *shape* in the unified
 * `variables` map (REQ-0076):
 *  - `null`              → a needs-value secret;
 *  - an `enc:`-prefixed  → an encrypted secret;
 *  - any other string    → a plain variable.
 */
export function isSecretValue(value: string | null): boolean {
  return value === null || value.startsWith('enc:')
}

/**
 * True when the whole value is a single complete `{{name}}` reference (ignoring
 * surrounding whitespace). The reference *name* is not a secret, so such a value
 * may be shown in clear text in a masked secret field; anything else — a literal
 * (even one beginning with `{`), a reference with surrounding literal text, or a
 * reference still being typed — is a possible secret and must stay masked.
 *
 * This is the single criterion shared by the secret-input mask decision and the
 * clear-text-literal passphrase warning, so the two cannot diverge.
 */
export function isCompleteVariableReference(value: string): boolean {
  return /^\s*\{\{[^{}]+\}\}\s*$/.test(value)
}

/**
 * A suggestable variable: its name and its kind. Never a value.
 * `isDynamic` marks a system dynamic variable (`{{$name}}`, REQ-0087) — these are
 * virtual, belong to no environment, and carry a dedicated icon/color.
 */
export interface VariableSuggestion {
  name: string
  isSecret: boolean
  isDynamic?: boolean
}

/**
 * Build the suggestion list from the active environment's unified `variables`
 * map, then append the system dynamic variables (REQ-0087). Every declared env
 * name is offered first (plain, encrypted, needs-value), in map insertion order,
 * tagged with `isSecret`; the dynamic variables follow in one flat list (no
 * section headers). No value is carried.
 *
 * Because the `$` prefix is reserved, typing `$` after `{{` filters the list down
 * to dynamic variables only (no env name matches), so the two kinds separate
 * themselves after one keystroke; the flat env-first ordering matters only in the
 * bare-`{{` state (CA-08).
 *
 * `{{$env.NAME}}` is never offered because it is never a *key* of the map — it
 * is a reference that may appear only inside a variable's value.
 */
export function buildVariableSuggestions(
  variables: Record<string, string | null>
): VariableSuggestion[] {
  const env: VariableSuggestion[] = Object.entries(variables).map(([name, value]) => ({
    name,
    isSecret: isSecretValue(value)
  }))
  const dynamic: VariableSuggestion[] = DYNAMIC_VARIABLE_NAMES.map((name) => ({
    name,
    isSecret: false,
    isDynamic: true
  }))
  return [...env, ...dynamic]
}

/**
 * Filter the suggestion list by a (possibly empty) partial name, case-insensitively.
 * An empty query returns the full list.
 */
export function filterVariableSuggestions(
  suggestions: VariableSuggestion[],
  query: string
): VariableSuggestion[] {
  const q = query.toLowerCase()
  if (q === '') return suggestions
  return suggestions.filter((s) => s.name.toLowerCase().includes(q))
}

/**
 * Given the text *before* the caret, return the partial variable name when the
 * caret sits inside an unclosed `{{` (e.g. `…{{ba` → `"ba"`, `…{{` → `""`), or
 * `null` when the caret is not inside an open placeholder.
 */
export function getOpenVariableQuery(textBeforeCaret: string): string | null {
  const match = /\{\{([^}]*)$/.exec(textBeforeCaret)
  return match ? match[1] : null
}

/**
 * Compute the edit that completes a `{{`-placeholder to exactly `{{name}}`,
 * idempotent with respect to closing braces already present after the caret
 * (REQ-0078 §6.2).
 *
 * The caller is expected to have located the start of the open `{{` (the
 * replacement `from`) and the caret (`to`). This returns:
 *  - `insert`  — the full `{{name}}` text to write at `from`;
 *  - `consume` — how many characters *after the caret* to also delete: the count
 *    of immediately-following `}` (capped at 2), so an already-auto-closed
 *    `{{|}}` becomes `{{name}}` rather than `{{name}}}}`.
 *
 * The caret should be placed at `from + insert.length` (after the closing `}}`).
 */
export function computeVariableCompletion(
  name: string,
  textAfterCaret: string
): { insert: string; consume: number } {
  let consume = 0
  while (consume < 2 && textAfterCaret[consume] === '}') consume++
  return { insert: `{{${name}}}`, consume }
}
