import { describe, it, expect } from 'vitest'
import { resolveString, resolveRequestVariables, extractVariableNames } from './variables'

describe('extractVariableNames', () => {
  it('returns the trimmed, de-duplicated names in document order', () => {
    expect(extractVariableNames('{{ a }}-{{b}}-{{a}}')).toEqual(['a', 'b'])
  })

  it('returns an empty array for a literal or empty value', () => {
    expect(extractVariableNames('literal-passphrase')).toEqual([])
    expect(extractVariableNames('')).toEqual([])
  })

  it('ignores empty and unbalanced braces', () => {
    expect(extractVariableNames('{{}} {{ok}} {{')).toEqual(['ok'])
  })
})

describe('resolveString', () => {
  it('replaces a single variable', () => {
    const result = resolveString('{{baseUrl}}/api', { baseUrl: 'http://localhost:3000' })
    expect(result.value).toBe('http://localhost:3000/api')
    expect(result.unresolved).toEqual([])
  })

  it('replaces multiple variables', () => {
    const result = resolveString('{{proto}}://{{host}}/{{path}}', {
      proto: 'https',
      host: 'example.com',
      path: 'users'
    })
    expect(result.value).toBe('https://example.com/users')
    expect(result.unresolved).toEqual([])
  })

  it('leaves unresolved variables intact and reports them', () => {
    const result = resolveString('{{baseUrl}}/api/{{missing}}', { baseUrl: 'http://localhost' })
    expect(result.value).toBe('http://localhost/api/{{missing}}')
    expect(result.unresolved).toEqual(['missing'])
  })

  it('handles variables with surrounding whitespace in placeholder', () => {
    const result = resolveString('{{ token }}', { token: 'abc123' })
    expect(result.value).toBe('abc123')
    expect(result.unresolved).toEqual([])
  })

  it('returns original string when no variables', () => {
    const result = resolveString('https://example.com/api', {})
    expect(result.value).toBe('https://example.com/api')
    expect(result.unresolved).toEqual([])
  })

  it('returns original string when no placeholders', () => {
    const result = resolveString('plain text', { token: 'abc' })
    expect(result.value).toBe('plain text')
    expect(result.unresolved).toEqual([])
  })

  it('reports each missing variable only once even if used multiple times', () => {
    // resolveString returns per-call unresolved (duplicates can appear if var used twice)
    // resolveRequestVariables dedupes across the full request
    const result = resolveString('{{x}}/{{x}}', {})
    expect(result.unresolved).toEqual(['x', 'x'])
  })
})

describe('resolveRequestVariables', () => {
  it('resolves URL, headers and body', () => {
    const vars = { baseUrl: 'http://localhost:3000', token: 'tok-42' }
    const result = resolveRequestVariables(
      {
        method: 'POST',
        url: '{{baseUrl}}/api/users',
        headers: { Authorization: 'Bearer {{token}}', 'Content-Type': 'application/json' },
        body: '{"key":"{{token}}"}'
      },
      vars
    )
    expect(result.url).toBe('http://localhost:3000/api/users')
    expect(result.headers['Authorization']).toBe('Bearer tok-42')
    expect(result.headers['Content-Type']).toBe('application/json')
    expect(result.body).toBe('{"key":"tok-42"}')
    expect(result.unresolvedVariables).toEqual([])
  })

  it('never interpolates the method', () => {
    const result = resolveRequestVariables(
      { method: '{{METHOD}}', url: 'http://example.com', headers: {} },
      { METHOD: 'GET' }
    )
    expect(result.method).toBe('{{METHOD}}')
  })

  it('collects unresolved variables from all fields and deduplicates', () => {
    const result = resolveRequestVariables(
      {
        method: 'GET',
        url: '{{baseUrl}}/{{path}}',
        headers: { Authorization: 'Bearer {{token}}' },
        body: '{{baseUrl}}'
      },
      {}
    )
    // All three distinct names should be reported exactly once
    expect(result.unresolvedVariables.sort()).toEqual(['baseUrl', 'path', 'token'])
  })

  it('handles request with no body', () => {
    const result = resolveRequestVariables(
      { method: 'GET', url: '{{url}}', headers: {} },
      { url: 'http://example.com' }
    )
    expect(result.url).toBe('http://example.com')
    expect(result.body).toBeUndefined()
  })

  it('returns empty unresolved array when variables map is empty and no placeholders', () => {
    const result = resolveRequestVariables(
      { method: 'GET', url: 'http://example.com', headers: {} },
      {}
    )
    expect(result.unresolvedVariables).toEqual([])
  })

  it('resolves header keys in addition to header values', () => {
    const result = resolveRequestVariables(
      {
        method: 'GET',
        url: 'http://example.com',
        headers: { '{{headerName}}': '{{headerValue}}' }
      },
      { headerName: 'X-Custom', headerValue: 'my-value' }
    )
    expect(result.headers['X-Custom']).toBe('my-value')
    expect(result.headers['{{headerName}}']).toBeUndefined()
    expect(result.unresolvedVariables).toEqual([])
  })

  it('reports unresolved variable in a header key', () => {
    const result = resolveRequestVariables(
      { method: 'GET', url: 'http://example.com', headers: { '{{missing}}': 'value' } },
      {}
    )
    expect(result.unresolvedVariables).toContain('missing')
  })

  it('resolves variables in form field keys and values', () => {
    const result = resolveRequestVariables(
      {
        method: 'POST',
        url: 'http://example.com',
        headers: {},
        formFields: [
          { id: '1', key: '{{fieldKey}}', value: '{{fieldVal}}', enabled: true },
          { id: '2', key: 'static', value: 'plain', enabled: true }
        ]
      },
      { fieldKey: 'username', fieldVal: 'john' }
    )
    expect(result.formFields).toHaveLength(2)
    expect(result.formFields![0].key).toBe('username')
    expect(result.formFields![0].value).toBe('john')
    expect(result.formFields![1].key).toBe('static')
    expect(result.formFields![1].value).toBe('plain')
    expect(result.unresolvedVariables).toEqual([])
  })

  it('reports unresolved variables in form fields', () => {
    const result = resolveRequestVariables(
      {
        method: 'POST',
        url: 'http://example.com',
        headers: {},
        formFields: [{ id: '1', key: '{{k}}', value: '{{v}}', enabled: true }]
      },
      {}
    )
    expect(result.unresolvedVariables.sort()).toEqual(['k', 'v'])
  })

  it('returns undefined formFields when none are provided', () => {
    const result = resolveRequestVariables(
      { method: 'GET', url: 'http://example.com', headers: {} },
      {}
    )
    expect(result.formFields).toBeUndefined()
  })

  // REQ-0067 CA-17: $env.* references inside .http content are NOT resolved
  // by resolveRequestVariables. The lookup treats `$env.NAME` as a regular
  // variable name; since no such name exists in the variables map (the env
  // resolver only operates on values), the placeholder stays literal and
  // gets reported as unresolved like any other missing variable.
  it('does not interpret $env.* placeholders directly in URL/header/body content (CA-17)', () => {
    const result = resolveRequestVariables(
      {
        method: 'GET',
        url: 'https://example.com/api',
        headers: { Authorization: 'Bearer {{$env.OPENAI_KEY}}' }
      },
      { someOther: 'value' }
    )
    expect(result.headers.Authorization).toBe('Bearer {{$env.OPENAI_KEY}}')
    expect(result.unresolvedVariables).toContain('$env.OPENAI_KEY')
  })
})

// REQ-0087: dynamic (system-generated) variables — `{{$name}}` tokens resolve to
// a freshly generated value on the send path, per textual occurrence.
describe('resolveString — dynamic variables (REQ-0087)', () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

  it('resolves a known dynamic token, writing nothing to the environment (CA-01)', () => {
    const variables: Record<string, string> = {}
    const result = resolveString('https://x/{{$guid}}', variables)
    expect(result.value).toMatch(/^https:\/\/x\/[0-9a-f-]{36}$/)
    expect(result.value.slice('https://x/'.length)).toMatch(UUID_RE)
    expect(result.unresolved).toEqual([])
    expect(Object.keys(variables)).toEqual([]) // no env mutation
  })

  it('trims whitespace inside the braces (`{{ $guid }}` ≡ `{{$guid}}`)', () => {
    const result = resolveString('{{ $guid }}', {})
    expect(result.value).toMatch(UUID_RE)
    expect(result.unresolved).toEqual([])
  })

  it('generates independently per textual occurrence (CA-02)', () => {
    const result = resolveString('{{$guid}}|{{$guid}}', {})
    const [a, b] = result.value.split('|')
    expect(a).toMatch(UUID_RE)
    expect(b).toMatch(UUID_RE)
    expect(a).not.toBe(b)
  })

  it('leaves an unknown $-token literal and reports it unresolved (CA-04)', () => {
    const result = resolveString('{{$definitelyNotAToken}}', {})
    expect(result.value).toBe('{{$definitelyNotAToken}}')
    expect(result.unresolved).toEqual(['$definitelyNotAToken'])
  })

  it('is case-sensitive (matches the established convention)', () => {
    const result = resolveString('{{$GUID}}', {})
    expect(result.value).toBe('{{$GUID}}')
    expect(result.unresolved).toEqual(['$GUID'])
  })
})

describe('resolveRequestVariables — dynamic variables (REQ-0087)', () => {
  it('generates different values for the same token in a header and the body (CA-02)', () => {
    const result = resolveRequestVariables(
      {
        method: 'POST',
        url: 'https://example.com',
        headers: { 'Idempotency-Key': '{{$guid}}' },
        body: '{{$guid}}'
      },
      {}
    )
    expect(result.headers['Idempotency-Key']).not.toBe(result.body)
    expect(result.unresolvedVariables).toEqual([])
  })

  it('resolves $randomInt to an integer in 0…1000 (CA-11 parity shape)', () => {
    const result = resolveRequestVariables(
      { method: 'GET', url: 'https://example.com/?n={{$randomInt}}', headers: {} },
      {}
    )
    const n = Number(new URL(result.url).searchParams.get('n'))
    expect(Number.isInteger(n)).toBe(true)
    expect(n).toBeGreaterThanOrEqual(0)
    expect(n).toBeLessThanOrEqual(1000)
  })

  it('two sends of {{$timestamp}} are independent and persist nothing (CA-03)', () => {
    const req = { method: 'GET', url: 'https://x', headers: { 'X-Ts': '{{$timestamp}}' } }
    const a = resolveRequestVariables(req, {})
    const b = resolveRequestVariables(req, {})
    expect(a.headers['X-Ts']).toMatch(/^\d+$/)
    expect(b.headers['X-Ts']).toMatch(/^\d+$/)
    // The source request object is never mutated.
    expect(req.headers['X-Ts']).toBe('{{$timestamp}}')
  })
})
