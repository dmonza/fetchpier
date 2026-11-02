import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { CompletionContext, type Completion } from '@codemirror/autocomplete'
import { DYNAMIC_VARIABLE_NAMES } from '@shared/lib/dynamic-variables'
import { variableCompletionSource } from './variableEditorExtension'
import { buildVariableSuggestions } from '../lib/variables-editing'

const DYNAMIC_COUNT = DYNAMIC_VARIABLE_NAMES.length
/** The env-declared labels of a completion result (drops appended dynamic vars). */
const envLabels = (labels: string[]): string[] => labels.slice(0, labels.length - DYNAMIC_COUNT)

function queryAt(doc: string, cursor: number, variables: Record<string, string | null>) {
  const source = variableCompletionSource(buildVariableSuggestions(variables))
  const state = EditorState.create({ doc, selection: { anchor: cursor } })
  const context = new CompletionContext(state, cursor, false)
  return { result: source(context), source }
}

/** Apply an option against a fresh view and return the resulting doc text. */
function applyOption(doc: string, cursor: number, option: Completion, from: number): string {
  const view = new EditorView({ state: EditorState.create({ doc, selection: { anchor: cursor } }) })
  // `apply` is the function form we always set in the source.
  ;(option.apply as (v: EditorView, c: Completion, f: number, t: number) => void)(
    view,
    option,
    from,
    cursor
  )
  const text = view.state.doc.toString()
  view.destroy()
  return text
}

describe('variableCompletionSource', () => {
  const variables = { baseUrl: 'https://x', apiKey: 'enc:v1:cipher', pending: null }

  it('returns null when the caret is not inside an open {{', () => {
    expect(queryAt('GET /path', 9, variables).result).toBeNull()
    expect(queryAt('GET {{baseUrl}}', 15, variables).result).toBeNull()
  })

  it('still offers the dynamic variables when the environment is empty (REQ-0087)', () => {
    const { result } = queryAt('{{', 2, {})
    expect(result).not.toBeNull()
    expect(result!.options.map((o) => o.label)).toEqual([...DYNAMIC_VARIABLE_NAMES])
    expect(result!.options.every((o) => o.type === 'dynamic')).toBe(true)
  })

  it('offers every declared name (plain + secret), then the dynamic variables (CA-01 / REQ-0087 CA-08)', () => {
    const { result } = queryAt('{{', 2, variables)
    expect(result).not.toBeNull()
    // `filter: false` so CodeMirror preserves our order (env-first) instead of
    // re-sorting alphabetically (which would float `$`-prefixed names to the top).
    expect(result!.filter).toBe(false)
    const labels = result!.options.map((o) => o.label)
    // Env names first, in map order…
    expect(envLabels(labels)).toEqual(['baseUrl', 'apiKey', 'pending'])
    // …then the dynamic variables, flagged with the dedicated `dynamic` type.
    expect(labels.slice(3)).toEqual([...DYNAMIC_VARIABLE_NAMES])
    const byLabel = Object.fromEntries(result!.options.map((o) => [o.label, o.type]))
    expect(byLabel.baseUrl).toBe('variable')
    expect(byLabel.apiKey).toBe('secret')
    expect(byLabel.pending).toBe('secret')
    expect(byLabel.$guid).toBe('dynamic')
  })

  it('filters to dynamic variables only after typing `$` (REQ-0087 CA-09)', () => {
    const { result } = queryAt('{{$', 3, variables)
    expect(result!.options.map((o) => o.label)).toEqual([...DYNAMIC_VARIABLE_NAMES])
    expect(result!.options.every((o) => o.type === 'dynamic')).toBe(true)
  })

  it('filters by the partial name after {{ (CA-04)', () => {
    const { result } = queryAt('{{ba', 4, variables)
    expect(result!.options.map((o) => o.label)).toEqual(['baseUrl'])
  })

  it('inserts a closed placeholder when nothing follows the caret (CA-02)', () => {
    const { result } = queryAt('{{', 2, variables)
    const opt = result!.options.find((o) => o.label === 'baseUrl')!
    expect(applyOption('{{', 2, opt, result!.from)).toBe('{{baseUrl}}')
  })

  it('is idempotent against auto-closed braces {{|}} (CA-03)', () => {
    const { result } = queryAt('{{}}', 2, variables)
    const opt = result!.options.find((o) => o.label === 'baseUrl')!
    expect(applyOption('{{}}', 2, opt, result!.from)).toBe('{{baseUrl}}')
  })

  it('replaces a partial prefix on selection (CA-04)', () => {
    const { result } = queryAt('{{ba', 4, variables)
    const opt = result!.options.find((o) => o.label === 'baseUrl')!
    expect(applyOption('{{ba', 4, opt, result!.from)).toBe('{{baseUrl}}')
  })

  it('preserves surrounding text when completing inside a larger document (CA-05)', () => {
    const doc = '{\n  "url": "{{ba"\n}'
    const cursor = doc.indexOf('{{ba') + 4
    const { result } = queryAt(doc, cursor, variables)
    const opt = result!.options.find((o) => o.label === 'baseUrl')!
    expect(applyOption(doc, cursor, opt, result!.from)).toBe('{\n  "url": "{{baseUrl}}"\n}')
  })
})
