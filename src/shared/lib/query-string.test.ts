import { describe, it, expect } from 'vitest'
import type { KeyValuePair } from '../types'
import {
  assembleQuery,
  encodeQueryComponent,
  encodeQueryComponentPreservingMasks,
  encodeTemplateComponent,
  splitFormBody,
  splitUrlAndParams,
  splitUrlFragment
} from './query-string'

function param(key: string, value: string, enabled = true): KeyValuePair {
  return { id: `${key}-${value}`, key, value, enabled }
}

// The template form of a query component: what a `.http` file or a run's
// `# @path-raw` stores. Tokens stay resolvable, literals are made URL-safe.
describe('encodeTemplateComponent', () => {
  it.each([
    ['a plain literal', 'page', 'page'],
    ['a literal needing escapes', 'a b&c=d', 'a%20b%26c%3Dd'],
    ['a token, verbatim', '{{token}}', '{{token}}'],
    ['a token inside literals', 'v-{{id}} x', 'v-{{id}}%20x'],
    ['the empty string', '', '']
  ])('%s', (_label, input, expected) => {
    expect(encodeTemplateComponent(input)).toBe(expected)
  })

  it('splits back to the authored values through splitUrlAndParams', () => {
    const params = [param('q', 'a b'), param('tok', '{{t}}'), param('amp', 'x&y')]
    const url = assembleQuery('{{baseUrl}}/s', params, true, encodeTemplateComponent)
    expect(url).toBe('{{baseUrl}}/s?q=a%20b&tok={{t}}&amp=x%26y')
    expect(splitUrlAndParams(url).params.map((p) => [p.key, p.value])).toEqual([
      ['q', 'a b'],
      ['tok', '{{t}}'],
      ['amp', 'x&y']
    ])
  })
})

describe('assembleQuery — contextual encoding (REQ-0081 §6.1)', () => {
  // CA-04: a resolved value with a space encodes to %20 (never `+`).
  it('CA-04: space in a value encodes to %20', () => {
    expect(assembleQuery('https://api/x', [param('clientId', 'ab cd')], true)).toBe(
      'https://api/x?clientId=ab%20cd'
    )
  })

  // CA-05 (adjusted): `&` in a value is encoded so it cannot split the query.
  // `=` is encoded in BOTH key and value (encodeURIComponent; decodes identically).
  it('CA-05: `&` in a value does not split; `=` is encoded in key and value', () => {
    expect(assembleQuery('https://api/x', [param('q', 'a&b')], true)).toBe('https://api/x?q=a%26b')
    expect(assembleQuery('https://api/x', [param('q', 'a=b')], true)).toBe('https://api/x?q=a%3Db')
    expect(assembleQuery('https://api/x', [param('a=b', 'v')], true)).toBe('https://api/x?a%3Db=v')
  })

  // §9.2 encode-set table: space, &, =, %, + across key and value positions.
  // Both positions use the same encoder, so the encoded form is identical.
  it.each([
    [' ', '%20'],
    ['&', '%26'],
    ['=', '%3D'],
    ['%', '%25'],
    ['+', '%2B']
  ])('encodes %j to %j in both key and value positions', (raw, encoded) => {
    expect(encodeQueryComponent(raw)).toBe(encoded)
    expect(assembleQuery('https://api', [param(`k${raw}`, `v${raw}`)], true)).toBe(
      `https://api?k${encoded}=v${encoded}`
    )
  })

  it('leaves unreserved characters unencoded', () => {
    expect(encodeQueryComponent("Aa0-_.~!'()*")).toBe("Aa0-_.~!'()*")
  })

  // CA-06: `encodeUrl` off passes resolved values through raw.
  it('CA-06: encodeUrl off sends values raw (no encoding, no new URL())', () => {
    expect(assembleQuery('https://api/x', [param('q', 'a b')], false)).toBe('https://api/x?q=a b')
    expect(assembleQuery('https://api/x', [param('q', 'a&b=c')], false)).toBe(
      'https://api/x?q=a&b=c'
    )
  })

  // CA-08: disabled parameters and empty-key parameters are dropped.
  it('CA-08: drops disabled and empty-key parameters', () => {
    const params = [
      param('a', '1'),
      param('b', '2', false),
      param('', 'orphan'),
      param('   ', 'blank')
    ]
    expect(assembleQuery('https://api', params, true)).toBe('https://api?a=1')
  })

  it('returns the base unchanged when no parameter survives the filter', () => {
    expect(assembleQuery('https://api', [param('x', 'y', false)], true)).toBe('https://api')
  })

  it('joins with & when the base already carries a query (e.g. api-key-in-query)', () => {
    expect(assembleQuery('https://api?apiKey=secret', [param('a', '1')], true)).toBe(
      'https://api?apiKey=secret&a=1'
    )
  })

  it('joins multiple parameters with &', () => {
    expect(assembleQuery('https://api', [param('a', '1'), param('b', '2')], true)).toBe(
      'https://api?a=1&b=2'
    )
  })
})

describe('encodeQueryComponentPreservingMasks — legible secret masks in the snapshot', () => {
  it('leaves a pure secret mask verbatim (no percent-encoding)', () => {
    expect(encodeQueryComponentPreservingMasks('{secret:apiKey}')).toBe('{secret:apiKey}')
  })

  it('encodes literal segments around a mask, leaving the mask intact', () => {
    // The literal `a b` is encoded; the mask is not.
    expect(encodeQueryComponentPreservingMasks('a b{secret:tok}c&d')).toBe('a%20b{secret:tok}c%26d')
  })

  it('encodes a normal value exactly like encodeQueryComponent when no mask is present', () => {
    expect(encodeQueryComponentPreservingMasks('a b&c')).toBe(encodeQueryComponent('a b&c'))
  })

  it('handles multiple masks in one value', () => {
    expect(encodeQueryComponentPreservingMasks('{secret:a} {secret:b}')).toBe(
      '{secret:a}%20{secret:b}'
    )
  })

  it('drives assembleQuery for the masked snapshot — mask stays legible', () => {
    const url = assembleQuery(
      'https://api/forecast',
      [param('city', 'berlin'), param('apiKey', '{secret:apiKey}')],
      true,
      encodeQueryComponentPreservingMasks
    )
    expect(url).toBe('https://api/forecast?city=berlin&apiKey={secret:apiKey}')
    expect(url).not.toContain('%7Bsecret')
  })
})

describe('splitUrlAndParams (moved to query-string, token-aware)', () => {
  it('splits base and params and preserves tokens verbatim', () => {
    const { baseUrl, params } = splitUrlAndParams('https://api/x?clientId={{clientId}}&n=a%20b')
    expect(baseUrl).toBe('https://api/x')
    expect(params.map((p) => ({ key: p.key, value: p.value }))).toEqual([
      { key: 'clientId', value: '{{clientId}}' },
      { key: 'n', value: 'a b' }
    ])
  })

  it('returns an empty list when there is no query', () => {
    expect(splitUrlAndParams('https://api/x')).toEqual({
      baseUrl: 'https://api/x',
      params: [],
      warnings: []
    })
  })

  // splitUrlAndParams ∘ assembleQuery round-trips a resolved (token-free) query.
  it('round-trips with assembleQuery for resolved values', () => {
    const url = assembleQuery('https://api/x', [param('a', 'hello world'), param('b', 'x&y')], true)
    const { baseUrl, params } = splitUrlAndParams(url)
    expect(baseUrl).toBe('https://api/x')
    expect(params.map((p) => ({ key: p.key, value: p.value }))).toEqual([
      { key: 'a', value: 'hello world' },
      { key: 'b', value: 'x&y' }
    ])
  })
})

// FMT-01: a fragment is not part of the query. It is split off first (token-aware)
// and kept on the base, so the URL text round-trips and no param ever carries it.
describe('URL fragment (FMT-01)', () => {
  it.each([
    ['none', 'https://h/items?a=1', 'https://h/items?a=1', ''],
    ['after the query', 'https://h/items?a=1#top', 'https://h/items?a=1', '#top'],
    ['with no query', 'https://h/items#top', 'https://h/items', '#top'],
    ['holding a ? and &', 'https://h/items#a?b=1&c', 'https://h/items', '#a?b=1&c'],
    ['empty', 'https://h/items?a=1#', 'https://h/items?a=1', '#'],
    [
      'after a token holding #',
      'https://h/{{p#1}}?a={{x#y}}#f',
      'https://h/{{p#1}}?a={{x#y}}',
      '#f'
    ],
    ['only a token holding #', 'https://h/x?a={{x#y}}', 'https://h/x?a={{x#y}}', '']
  ])('splitUrlFragment: %s', (_label, raw, url, fragment) => {
    expect(splitUrlFragment(raw)).toEqual({ url, fragment })
  })

  it.each([
    ['after the query', 'https://h/items?page=2#top', [['page', '2']], 'https://h/items#top'],
    ['after a bare ?', 'https://h/items?#frag', [['', '']], 'https://h/items#frag'],
    ['holding a ? and &', 'https://h/items#a?b=1&c', [], 'https://h/items#a?b=1&c'],
    ['splitting a later pair', 'https://h/x?a=1#f&b=2', [['a', '1']], 'https://h/x#f&b=2'],
    ['after a token holding #', 'https://h/x?a={{x#y}}#f', [['a', '{{x#y}}']], 'https://h/x#f']
  ])('splitUrlAndParams keeps a fragment %s out of the params', (_label, raw, pairs, base) => {
    const { baseUrl, params } = splitUrlAndParams(raw)
    expect(baseUrl).toBe(base)
    expect(params.map((p) => [p.key, p.value])).toEqual(pairs)
  })

  it('assembleQuery puts the query before the fragment of the base, encoding on or off', () => {
    const params = [param('page', '2'), param('q', 'a b')]
    expect(assembleQuery('https://h/items#top', params, true)).toBe(
      'https://h/items?page=2&q=a%20b#top'
    )
    expect(assembleQuery('https://h/items#top', params, false)).toBe(
      'https://h/items?page=2&q=a b#top'
    )
    // A `?` inside the fragment is not a query: the separator is still `?`.
    expect(assembleQuery('https://h/items#a?b', [param('page', '2')], true)).toBe(
      'https://h/items?page=2#a?b'
    )
    // An api-key query already on the base takes `&`, before the fragment.
    expect(assembleQuery('https://h/items?k=v#top', [param('page', '2')], true)).toBe(
      'https://h/items?k=v&page=2#top'
    )
  })

  it('split → assemble gives the URL back', () => {
    const raw = 'https://h/items?page=2&q=x#top'
    const { baseUrl, params } = splitUrlAndParams(raw)
    expect(assembleQuery(baseUrl, params, true)).toBe(raw)
  })
})

describe('splitUrlAndParams — malformed percent-encoding tolerance (REQ-0086)', () => {
  // CA-01: a malformed key does not abort the split; it is kept raw and reported.
  it('CA-01: a malformed key is kept raw, flagged, and reported', () => {
    const { baseUrl, params, warnings } = splitUrlAndParams('https://api/x?%E0=v')
    expect(baseUrl).toBe('https://api/x')
    expect(params).toEqual([
      { id: 'param-0', key: '%E0', value: 'v', enabled: true, malformed: true }
    ])
    expect(warnings).toEqual([{ code: 'MALFORMED_QUERY_ENCODING', rawKey: '%E0', index: 0 }])
  })

  // A malformed VALUE shares the same decode path and gets identical containment.
  it('contains a malformed value too (keys and values share the path)', () => {
    const { params, warnings } = splitUrlAndParams('https://api/x?k=%E0')
    expect(params[0]).toMatchObject({ key: 'k', value: '%E0', malformed: true })
    expect(warnings).toHaveLength(1)
  })

  // CA-02: containment is isolated — sibling params decode normally.
  it('CA-02: only the offending parameter is affected', () => {
    const { params, warnings } = splitUrlAndParams('https://api/x?ok=a%20b&%E0=bad&also=fine')
    expect(params.map((p) => ({ key: p.key, value: p.value, malformed: p.malformed }))).toEqual([
      { key: 'ok', value: 'a b', malformed: undefined },
      { key: '%E0', value: 'bad', malformed: true },
      { key: 'also', value: 'fine', malformed: undefined }
    ])
    expect(warnings).toEqual([{ code: 'MALFORMED_QUERY_ENCODING', rawKey: '%E0', index: 1 }])
  })

  // §9.2: multiple malformed keys → one warning per key, single successful split.
  it('emits one warning per malformed key and still splits successfully', () => {
    const { params, warnings } = splitUrlAndParams('https://api/x?%E0=1&good=2&%C3=3')
    expect(params).toHaveLength(3)
    expect(warnings.map((w) => w.index)).toEqual([0, 2])
    expect(warnings.every((w) => w.code === 'MALFORMED_QUERY_ENCODING')).toBe(true)
  })

  // CA-03: assembleQuery emits a malformed pair literally even with encodeUrl on.
  it('CA-03: assembleQuery emits the malformed pair raw (no double-encoding)', () => {
    const malformed: KeyValuePair = {
      id: 'm',
      key: '%E0',
      value: 'v',
      enabled: true,
      malformed: true
    }
    expect(assembleQuery('https://api/x', [malformed], true)).toBe('https://api/x?%E0=v')
    // A well-formed sibling is still encoded normally alongside it.
    expect(assembleQuery('https://api/x', [malformed, param('q', 'a b')], true)).toBe(
      'https://api/x?%E0=v&q=a%20b'
    )
  })
})

// ── Value-less query parameters (REQ-0124) ──────────────────────────────────
// `?wsdl` and `?wsdl=` are different requests to a server that dispatches on a
// bare flag token. The distinction is born here, at the split, and honored at
// every site that rebuilds a query from structured parameters.

describe('splitUrlAndParams — value-less parameters (REQ-0124)', () => {
  it('flags a segment written without `=`, and not one written with it', () => {
    expect(splitUrlAndParams('https://svc/orders.aspx?wsdl').params[0]).toMatchObject({
      key: 'wsdl',
      value: '',
      valueless: true
    })
    const withEq = splitUrlAndParams('https://svc/orders.aspx?wsdl=').params[0]
    expect(withEq).toMatchObject({ key: 'wsdl', value: '' })
    expect(withEq.valueless).toBeFalsy()
  })

  it('decides per parameter, preserving author order', () => {
    const { params } = splitUrlAndParams('https://api/x?a&b=&c=1')
    expect(params.map((p) => [p.key, p.value, Boolean(p.valueless)])).toEqual([
      ['a', '', true],
      ['b', '', false],
      ['c', '1', false]
    ])
  })

  it('splits on the FIRST `=`, so a value containing `=` is not value-less', () => {
    const { params } = splitUrlAndParams('https://api/x?filter=a=b')
    expect(params[0]).toMatchObject({ key: 'filter', value: 'a=b' })
    expect(params[0].valueless).toBeFalsy()
  })

  it('leaves the bare `?` placeholder untouched (it has no key, so no flag)', () => {
    const { params } = splitUrlAndParams('https://api/x?')
    expect(params).toEqual([{ id: 'param-0', key: '', value: '', enabled: true }])
  })

  it('decodes a value-less key token-aware, exactly like any other key', () => {
    const { params } = splitUrlAndParams('https://api/x?a%20b')
    expect(params[0]).toMatchObject({ key: 'a b', value: '', valueless: true })
  })
})

describe('assembleQuery — value-less parameters (REQ-0124)', () => {
  function flag(key: string, enabled = true): KeyValuePair {
    return { id: `f-${key}`, key, value: '', enabled, valueless: true }
  }

  it('emits the bare key with encoding on — no `=`, no value', () => {
    expect(assembleQuery('https://svc/orders.aspx', [flag('wsdl')], true)).toBe(
      'https://svc/orders.aspx?wsdl'
    )
  })

  it('emits the bare key with encoding off', () => {
    expect(assembleQuery('https://svc/orders.aspx', [flag('wsdl')], false)).toBe(
      'https://svc/orders.aspx?wsdl'
    )
  })

  it('still encodes the key itself when encoding is on', () => {
    expect(assembleQuery('https://api/x', [flag('a b')], true)).toBe('https://api/x?a%20b')
  })

  it('mixes with valued parameters in author order', () => {
    expect(
      assembleQuery(
        'https://api/x',
        [param('q', 'shoes'), flag('pretty'), param('page', '2')],
        true
      )
    ).toBe('https://api/x?q=shoes&pretty&page=2')
  })

  it('emits a value-less malformed key verbatim, without adding `=`', () => {
    const raw: KeyValuePair = {
      id: 'm',
      key: '%E0',
      value: '',
      enabled: true,
      valueless: true,
      malformed: true
    }
    expect(assembleQuery('https://api/x', [raw], true)).toBe('https://api/x?%E0')
  })

  it('still drops a value-less parameter that is disabled or has an empty key', () => {
    expect(assembleQuery('https://api/x', [flag('wsdl', false)], true)).toBe('https://api/x')
    expect(assembleQuery('https://api/x', [flag('')], true)).toBe('https://api/x')
  })

  it('round-trips split → assemble byte-identically', () => {
    const url = 'https://api/x?a&b=&c=1'
    const { baseUrl, params } = splitUrlAndParams(url)
    expect(assembleQuery(baseUrl, params, true)).toBe(url)
  })
})

// One decoder for a form-urlencoded body, shared by the desktop loader, the
// history Open builder and the core's fallback for a raw form body (CLI).
describe('splitFormBody — form-urlencoded body into fields', () => {
  const pairs = (body: string) => splitFormBody(body).map((f) => [f.key, f.value])

  it('splits on `&`, then on the first `=`; every field is enabled with a stable id', () => {
    expect(splitFormBody('a=1&b=x=y')).toEqual([
      { id: 'f-0', key: 'a', value: '1', enabled: true },
      { id: 'f-1', key: 'b', value: 'x=y', enabled: true }
    ])
  })

  it('drops empty pairs and reads a pair without `=` as a key with an empty value', () => {
    expect(pairs('&a=1&&flag&')).toEqual([
      ['a', '1'],
      ['flag', '']
    ])
  })

  it('reads `+` as a space and `%2B` as a plus (form semantics)', () => {
    expect(pairs('scope=openid+profile&sig=a%2Bb&k+1=v')).toEqual([
      ['scope', 'openid profile'],
      ['sig', 'a+b'],
      ['k 1', 'v']
    ])
  })

  it('decodes literal segments only; `{{tokens}}` stay verbatim, `+` and `%` included', () => {
    expect(pairs('id={{client+id}}&x=a+{{b%41}}%20c')).toEqual([
      ['id', '{{client+id}}'],
      ['x', 'a {{b%41}} c']
    ])
  })

  it('keeps the raw text of a literal with a malformed escape; siblings still decode', () => {
    expect(pairs('discount=10%&scope=read+write&bad%E0=v')).toEqual([
      ['discount', '10%'],
      ['scope', 'read write'],
      ['bad%E0', 'v']
    ])
  })

  it('returns no fields for an empty body', () => {
    expect(splitFormBody('')).toEqual([])
  })
})
