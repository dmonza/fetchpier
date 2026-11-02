import { describe, it, expect } from 'vitest'
import { DYNAMIC_VARIABLE_NAMES } from '@shared/lib/dynamic-variables'
import {
  isSecretValue,
  isCompleteVariableReference,
  buildVariableSuggestions,
  filterVariableSuggestions,
  getOpenVariableQuery,
  computeVariableCompletion
} from './variables-editing'

const DYNAMIC_COUNT = DYNAMIC_VARIABLE_NAMES.length
/** The env-declared portion of a suggestion list (drops the appended dynamic vars). */
const envPart = <T>(list: T[]): T[] => list.slice(0, list.length - DYNAMIC_COUNT)

describe('isSecretValue', () => {
  it('classifies null as secret (needs-value)', () => {
    expect(isSecretValue(null)).toBe(true)
  })
  it('classifies enc: prefixed strings as secret', () => {
    expect(isSecretValue('enc:v1:abc')).toBe(true)
  })
  it('classifies plain strings as not secret', () => {
    expect(isSecretValue('https://api.example.com')).toBe(false)
    expect(isSecretValue('')).toBe(false)
  })
})

// The single criterion shared by the secret-input mask decision and the
// clear-text-literal passphrase warning (REQ-0090 §6.2, CA-07).
describe('isCompleteVariableReference', () => {
  it('is true only when the whole value is a single complete {{name}} reference', () => {
    expect(isCompleteVariableReference('{{x}}')).toBe(true)
    expect(isCompleteVariableReference('{{cert_pass}}')).toBe(true)
    expect(isCompleteVariableReference('  {{cert_pass}}  ')).toBe(true)
    expect(isCompleteVariableReference('{{$guid}}')).toBe(true)
  })

  it('is false for a literal — including one beginning with a brace', () => {
    expect(isCompleteVariableReference('')).toBe(false)
    expect(isCompleteVariableReference('plain')).toBe(false)
    expect(isCompleteVariableReference('{p@ss}')).toBe(false)
    expect(isCompleteVariableReference('{')).toBe(false)
  })

  it('is false for an in-progress reference', () => {
    expect(isCompleteVariableReference('{{')).toBe(false)
    expect(isCompleteVariableReference('{{cert')).toBe(false)
    expect(isCompleteVariableReference('{{cert}')).toBe(false)
  })

  it('is false for a reference with surrounding literal text or a second token', () => {
    expect(isCompleteVariableReference('{{cert_pass}}tail')).toBe(false)
    expect(isCompleteVariableReference('pre{{cert_pass}}')).toBe(false)
    expect(isCompleteVariableReference('{{a}}{{b}}')).toBe(false)
  })
})

describe('buildVariableSuggestions', () => {
  it('offers every declared name with its secret flag, no value', () => {
    const env = envPart(
      buildVariableSuggestions({
        baseUrl: 'https://api.example.com',
        apiKey: 'enc:v1:cipher',
        pending: null
      })
    )
    expect(env).toEqual([
      { name: 'baseUrl', isSecret: false },
      { name: 'apiKey', isSecret: true },
      { name: 'pending', isSecret: true }
    ])
    // Env entries carry no value field and are not flagged dynamic.
    for (const s of env) {
      expect(Object.keys(s).sort()).toEqual(['isSecret', 'name'])
    }
  })

  it('never offers a $env.* entry — it is never a key', () => {
    // `{{$env.OPENAI_KEY}}` lives inside a value, not as a key.
    const env = envPart(buildVariableSuggestions({ apiKey: '{{$env.OPENAI_KEY}}' }))
    expect(env.map((s) => s.name)).toEqual(['apiKey'])
    expect(env.some((s) => s.name.includes('$env'))).toBe(false)
  })

  // REQ-0087: dynamic variables appear after env names in one flat list (CA-08).
  it('appends the dynamic variables after the env names, flagged isDynamic (CA-08)', () => {
    const suggestions = buildVariableSuggestions({ baseUrl: 'x', token: null })
    // First come the env names in map order…
    expect(suggestions.slice(0, 2).map((s) => s.name)).toEqual(['baseUrl', 'token'])
    // …then every dynamic variable, in registry order, each flagged dynamic.
    const dynamic = suggestions.slice(2)
    expect(dynamic.map((s) => s.name)).toEqual([...DYNAMIC_VARIABLE_NAMES])
    expect(dynamic.every((s) => s.isDynamic === true && s.isSecret === false)).toBe(true)
  })

  it('offers the dynamic variables even for an empty environment', () => {
    const suggestions = buildVariableSuggestions({})
    expect(suggestions.map((s) => s.name)).toEqual([...DYNAMIC_VARIABLE_NAMES])
  })
})

describe('filterVariableSuggestions', () => {
  const list = buildVariableSuggestions({ baseUrl: 'x', apiBase: 'y', token: null })

  it('returns all entries (env + dynamic) for an empty query', () => {
    expect(filterVariableSuggestions(list, '')).toHaveLength(3 + DYNAMIC_COUNT)
  })

  // REQ-0087: typing `$` filters down to dynamic variables only (CA-09).
  it('filters to dynamic variables only when the query starts with `$` (CA-09)', () => {
    const filtered = filterVariableSuggestions(list, '$')
    expect(filtered.length).toBe(DYNAMIC_COUNT)
    expect(filtered.every((s) => s.isDynamic === true)).toBe(true)
    expect(filtered.map((s) => s.name)).toEqual([...DYNAMIC_VARIABLE_NAMES])
  })

  it('narrows dynamic matches further as more is typed', () => {
    expect(filterVariableSuggestions(list, '$guid').map((s) => s.name)).toEqual(['$guid'])
  })
  it('filters case-insensitively by substring', () => {
    expect(filterVariableSuggestions(list, 'base').map((s) => s.name)).toEqual([
      'baseUrl',
      'apiBase'
    ])
    expect(filterVariableSuggestions(list, 'TOK').map((s) => s.name)).toEqual(['token'])
  })
  it('returns an empty list when nothing matches', () => {
    expect(filterVariableSuggestions(list, 'zzz')).toEqual([])
  })
})

describe('getOpenVariableQuery', () => {
  it('returns the empty string right after {{', () => {
    expect(getOpenVariableQuery('GET {{')).toBe('')
  })
  it('returns the partial name inside an open placeholder', () => {
    expect(getOpenVariableQuery('GET {{ba')).toBe('ba')
  })
  it('returns null when not inside an open placeholder', () => {
    expect(getOpenVariableQuery('GET {{baseUrl}}')).toBeNull()
    expect(getOpenVariableQuery('plain text')).toBeNull()
  })
})

describe('computeVariableCompletion', () => {
  it('inserts a closed placeholder when nothing follows the caret (CA-02)', () => {
    // caret at `{{|`
    expect(computeVariableCompletion('baseUrl', '')).toEqual({
      insert: '{{baseUrl}}',
      consume: 0
    })
  })

  it('is idempotent against auto-closed braces — consumes the existing }} (CA-03)', () => {
    // caret at `{{|}}`
    expect(computeVariableCompletion('baseUrl', '}}')).toEqual({
      insert: '{{baseUrl}}',
      consume: 2
    })
  })

  it('consumes at most two closing braces', () => {
    expect(computeVariableCompletion('x', '}}}')).toEqual({ insert: '{{x}}', consume: 2 })
  })

  it('consumes a single orphan closing brace', () => {
    expect(computeVariableCompletion('x', '}')).toEqual({ insert: '{{x}}', consume: 1 })
  })

  it('does not consume non-brace trailing text', () => {
    expect(computeVariableCompletion('x', '/path')).toEqual({ insert: '{{x}}', consume: 0 })
  })
})
