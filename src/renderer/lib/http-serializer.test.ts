import { describe, it, expect } from 'vitest'
import {
  computeEditableUrl,
  computeFullUrl,
  splitUrlAndParams,
  serializeRequest
} from '@shared/lib/http-serializer'
import type { KeyValuePair, RequestEditorState } from '../../shared/types'
import { DEFAULT_REQUEST_STATE } from '../../shared/types'

function makeState(overrides: Partial<RequestEditorState> = {}): RequestEditorState {
  return { ...DEFAULT_REQUEST_STATE, ...overrides }
}

function kv(id: string, key: string, value: string, enabled = true): KeyValuePair {
  return { id, key, value, enabled }
}

/** A query parameter authored with no `=` at all (REQ-0124). */
function flag(id: string, key: string, enabled = true): KeyValuePair {
  return { id, key, value: '', enabled, valueless: true }
}

// ── computeFullUrl ──────────────────────────────────────────────────────────

describe('computeFullUrl', () => {
  it('returns base URL when params array is empty', () => {
    expect(computeFullUrl('https://api.com/users', [])).toBe('https://api.com/users')
  })

  // FMT-01: the fragment rides on the base and is shown after the query.
  it('puts the query before a fragment of the base, and gives back the typed URL', () => {
    expect(computeFullUrl('https://api.com/items#top', [kv('1', 'page', '2')])).toBe(
      'https://api.com/items?page=2#top'
    )
    expect(computeFullUrl('https://api.com/items#top', [kv('1', '', '')])).toBe(
      'https://api.com/items?#top'
    )
    for (const typed of ['https://api.com/items?page=2#top', 'https://api.com/items?#top']) {
      const { baseUrl, params } = splitUrlAndParams(typed)
      expect(computeFullUrl(baseUrl, params)).toBe(typed)
    }
  })

  // A literal `#` in a Params-table key or value is shown as `%23`: the URL bar
  // re-splits its text on every edit, and a bare `#` would be cut off as the
  // fragment (and never sent). A `#` inside a {{token}} is left as typed.
  it('shows a # in a param key or value as %23, so a URL-bar edit keeps it', () => {
    const params = [kv('1', 'color', '#fff'), kv('2', 'a#b', '{{x#y}}')]
    const shown = computeFullUrl('https://api.test/p', params)
    expect(shown).toBe('https://api.test/p?color=%23fff&a%23b={{x#y}}')
    const { baseUrl, params: back } = splitUrlAndParams(shown)
    expect(baseUrl).toBe('https://api.test/p')
    expect(back.map((p) => [p.key, p.value])).toEqual([
      ['color', '#fff'],
      ['a#b', '{{x#y}}']
    ])
  })

  it('appends enabled params as query string', () => {
    const params = [kv('1', 'page', '1'), kv('2', 'limit', '10')]
    expect(computeFullUrl('https://api.com/users', params)).toBe(
      'https://api.com/users?page=1&limit=10'
    )
  })

  it('excludes disabled params', () => {
    const params = [kv('1', 'page', '1'), kv('2', 'limit', '10', false)]
    expect(computeFullUrl('https://api.com/users', params)).toBe('https://api.com/users?page=1')
  })

  it('excludes params with empty key', () => {
    const params = [kv('1', '', 'ignored'), kv('2', 'page', '1')]
    expect(computeFullUrl('https://api.com/users', params)).toBe('https://api.com/users?page=1')
  })

  it('returns base URL when all params are disabled or have empty keys', () => {
    const params = [kv('1', '', 'x', true), kv('2', 'key', 'val', false)]
    expect(computeFullUrl('https://api.com', params)).toBe('https://api.com')
  })

  it('appends bare ? when the only enabled params are empty placeholders', () => {
    const params = [kv('1', '', '')]
    expect(computeFullUrl('https://api.com', params)).toBe('https://api.com?')
  })

  it('handles empty value params', () => {
    const params = [kv('1', 'search', '')]
    expect(computeFullUrl('https://api.com', params)).toBe('https://api.com?search=')
  })

  // REQ-0124: the URL bar must render back exactly what was typed. A parameter
  // authored without `=` stays without it; its empty-valued sibling keeps the `=`.
  it('renders a value-less param as a bare key, and its empty-valued sibling with `=`', () => {
    expect(computeFullUrl('https://svc/orders.aspx', [flag('1', 'wsdl')])).toBe(
      'https://svc/orders.aspx?wsdl'
    )
    expect(computeFullUrl('https://svc/orders.aspx', [kv('1', 'wsdl', '')])).toBe(
      'https://svc/orders.aspx?wsdl='
    )
  })

  it('mixes value-less and valued params in author order', () => {
    const params = [kv('1', 'q', 'shoes'), flag('2', 'pretty'), kv('3', 'page', '2')]
    expect(computeFullUrl('https://api.com', params)).toBe('https://api.com?q=shoes&pretty&page=2')
  })

  it('renames a value-less param without introducing `=` (key edits preserve it)', () => {
    expect(computeFullUrl('https://svc/orders.aspx', [flag('1', 'servicio')])).toBe(
      'https://svc/orders.aspx?servicio'
    )
  })

  it('does not percent-encode values (for human-readable display)', () => {
    const params = [kv('1', 'q', 'hello world')]
    expect(computeFullUrl('https://api.com', params)).toBe('https://api.com?q=hello world')
  })
})

// ── computeEditableUrl (ISS-0052) ───────────────────────────────────────────
//
// The URL bar re-splits its text on every keystroke, so the text it holds while
// focused must give back the same params under splitUrlAndParams. Only the
// characters the split reads as syntax are escaped: `%`, `&` and `#`, plus `=`
// in a key. {{tokens}} are left as typed; a malformed pair keeps its raw bytes.

/** What the split gives back, minus the positional ids it regenerates. */
function shape(params: KeyValuePair[]): Array<[string, string, boolean, boolean]> {
  return params.map((p) => [p.key, p.value, p.valueless === true, p.malformed === true])
}

describe('computeEditableUrl', () => {
  it('escapes %, & and # in keys and values, and = in keys only', () => {
    const params = [
      kv('1', 'discount', '100%'),
      kv('2', 'x', '%41'),
      kv('3', 'redirect', 'https://app.test/cb?a=1&b=2'),
      kv('4', 'a=b', 'c=d'),
      kv('5', 'k&#', 'v#&'),
      flag('6', 'f=g')
    ]
    expect(computeEditableUrl('https://api.test/p', params)).toBe(
      'https://api.test/p?discount=100%25&x=%2541&redirect=https://app.test/cb?a=1%26b=2' +
        '&a%3Db=c=d&k%26%23=v%23%26&f%3Dg'
    )
  })

  it('leaves {{tokens}}, spaces, + and other characters as typed', () => {
    const params = [kv('1', '{{a%b}}', '{{x#y}}'), kv('2', 'q', 'hello world+1 é/?:')]
    expect(computeEditableUrl('https://api.test/p', params)).toBe(
      'https://api.test/p?{{a%b}}={{x#y}}&q=hello world+1 é/?:'
    )
  })

  it('passes a malformed pair through raw, so it re-splits as the same malformed pair', () => {
    const params: KeyValuePair[] = [
      { id: '1', key: '%E0', value: 'x%', enabled: true, malformed: true },
      kv('2', 'ok', '1%')
    ]
    const text = computeEditableUrl('https://api.test/p', params)
    expect(text).toBe('https://api.test/p?%E0=x%&ok=1%25')
    expect(shape(splitUrlAndParams(text).params)).toEqual([
      ['%E0', 'x%', false, true],
      ['ok', '1%', false, false]
    ])
  })

  it('keeps the display rules of computeFullUrl: no query, bare ?, fragment, disabled rows', () => {
    expect(computeEditableUrl('https://api.test/p', [])).toBe('https://api.test/p')
    expect(computeEditableUrl('https://api.test/p#top', [kv('1', '', '')])).toBe(
      'https://api.test/p?#top'
    )
    expect(
      computeEditableUrl('https://api.test/p#top', [kv('1', 'a', '&'), kv('2', 'b', '1', false)])
    ).toBe('https://api.test/p?a=%26#top')
  })

  // Property: for every combination of the characters the split treats as
  // syntax (and their neighbours), split(edit(base, params)) gives back the
  // enabled keyed params exactly — key, value and the value-less flag.
  it('round-trips through splitUrlAndParams for values with &, =, %, %XX and #', () => {
    const pieces = ['a', '&', '=', '%', '%41', '%25', '#', ' ', '+', '?', '{{v}}', '{{a%b}}', 'é']
    const words: string[] = ['']
    for (const p of pieces) words.push(p, `x${p}`, `${p}y`)
    for (const p of pieces) for (const q of pieces) words.push(p + q)
    const keys = words.filter((w) => w.trim() !== '')

    for (const base of ['https://api.test/p', 'https://api.test/p#frag']) {
      for (let i = 0; i < keys.length; i++) {
        const value = words[(i * 7) % words.length]
        const params: KeyValuePair[] = [
          kv('1', keys[i], value),
          kv('2', 'next', words[(i * 13 + 5) % words.length]),
          flag('3', keys[(i * 11 + 3) % keys.length])
        ]
        const text = computeEditableUrl(base, params)
        const back = splitUrlAndParams(text)
        expect(back.baseUrl, text).toBe(base)
        expect(shape(back.params), text).toEqual(shape(params))
      }
    }
  })

  // The issue's example: open the stored request, focus the URL bar, change the
  // host, save. Only the host changes in the file.
  it('a host edit in the URL bar keeps every encoded param when the request is saved', () => {
    const query =
      'client_id=abc&redirect_uri=https%3A%2F%2Fapp.example.com%2Fcb%3Fa%3D1%26b%3D2' +
      '&discount=100%25&x=%2541'
    const loaded = splitUrlAndParams(`https://auth.example.com/authorize?${query}`)
    const text = computeEditableUrl(loaded.baseUrl, loaded.params)
    const edited = splitUrlAndParams(text.replace('auth.example.com', 'auth2.example.com'))
    expect(shape(edited.params)).toEqual(shape(loaded.params))
    const saved = serializeRequest(
      makeState({ method: 'GET', url: edited.baseUrl, params: edited.params })
    )
    expect(saved).toContain(`GET https://auth2.example.com/authorize?${query}\n`)
  })
})

// ── splitUrlAndParams (round-trip with computeFullUrl) ──────────────────────

describe('splitUrlAndParams round-trip', () => {
  it('parses params typed in URL bar and rebuilds correctly', () => {
    const raw = 'https://api.com/users?page=1&limit=10'
    const { baseUrl, params } = splitUrlAndParams(raw)
    expect(baseUrl).toBe('https://api.com/users')
    expect(params).toHaveLength(2)
    expect(params[0]).toMatchObject({ key: 'page', value: '1', enabled: true })
    expect(params[1]).toMatchObject({ key: 'limit', value: '10', enabled: true })
    expect(computeFullUrl(baseUrl, params)).toBe(raw)
  })

  it('handles URL without query string', () => {
    const { baseUrl, params } = splitUrlAndParams('https://api.com/users')
    expect(baseUrl).toBe('https://api.com/users')
    expect(params).toHaveLength(0)
    expect(computeFullUrl(baseUrl, params)).toBe('https://api.com/users')
  })

  it('decodes percent-encoded values when parsing', () => {
    const { baseUrl, params } = splitUrlAndParams('https://api.com?q=hello%20world')
    expect(baseUrl).toBe('https://api.com')
    expect(params[0]).toMatchObject({ key: 'q', value: 'hello world' })
  })

  it('handles param with no value', () => {
    const { baseUrl, params } = splitUrlAndParams('https://api.com?foo')
    expect(baseUrl).toBe('https://api.com')
    expect(params[0]).toMatchObject({ key: 'foo', value: '' })
  })

  it('bare ? returns one empty placeholder param', () => {
    const { baseUrl, params } = splitUrlAndParams('https://api.com?')
    expect(baseUrl).toBe('https://api.com')
    expect(params).toHaveLength(1)
    expect(params[0]).toMatchObject({ key: '', value: '', enabled: true })
  })

  it('round-trip: bare ? rebuilds to bare ?', () => {
    const raw = 'https://api.com/users?'
    const { baseUrl, params } = splitUrlAndParams(raw)
    expect(computeFullUrl(baseUrl, params)).toBe(raw)
  })
})

// ── splitUrlAndParams token-aware load (REQ-0080 §6.4) ──────────────────────

describe('splitUrlAndParams — token-aware load (REQ-0080)', () => {
  it('CA-01/02: leaves {{variable}} tokens in key and value undecoded', () => {
    const { params } = splitUrlAndParams('https://api.com?{{header}}={{clientId}}')
    expect(params[0]).toMatchObject({ key: '{{header}}', value: '{{clientId}}' })
  })

  it('still decodes literal segments around a token', () => {
    const { params } = splitUrlAndParams('https://api.com?q=a%26b%20{{x}}')
    expect(params[0]).toMatchObject({ key: 'q', value: 'a&b {{x}}' })
  })

  it('CA-08: a valid-looking % escape inside a token is not decoded', () => {
    const { params } = splitUrlAndParams('https://api.com?k={{a%41b}}')
    expect(params[0]).toMatchObject({ key: 'k', value: '{{a%41b}}' })
  })

  it('CA-09: an invalid % escape inside a token does not throw on load', () => {
    expect(() => splitUrlAndParams('https://api.com?k={{a%b}}')).not.toThrow()
    const { params } = splitUrlAndParams('https://api.com?k={{a%b}}')
    expect(params[0]).toMatchObject({ key: 'k', value: '{{a%b}}' })
  })
})

// ── serializeRequest ↔ splitUrlAndParams round-trip (REQ-0080 CA-04/08) ──────

describe('query token round-trip (REQ-0080)', () => {
  function storedQuery(value: string): string {
    const out = serializeRequest(
      makeState({ method: 'GET', url: 'https://api.com/x', params: [kv('1', 'k', value)] })
    )
    const line = out.split('\n').find((l) => l.includes('?'))!
    return line.replace(/^\S+\s+/, '').replace(/\s+HTTP.*$/, '')
  }

  it.each(['{{clientId}}', 'user-{{userId}}', 'a&b {{x}}', '{{a%41b}}'])(
    'load → save is byte-identical for value %j',
    (value) => {
      const first = storedQuery(value)
      const { params } = splitUrlAndParams(first)
      const second = serializeRequest(
        makeState({ method: 'GET', url: 'https://api.com/x', params })
      )
        .split('\n')
        .find((l) => l.includes('?'))!
        .replace(/^\S+\s+/, '')
        .replace(/\s+HTTP.*$/, '')
      expect(second).toBe(first)
    }
  )

  it('CA-08: {{a%41b}} displays verbatim (not {{aAb}}) after load', () => {
    const stored = storedQuery('{{a%41b}}')
    const { params } = splitUrlAndParams(stored)
    expect(params[0].value).toBe('{{a%41b}}')
  })
})

// ── serializeRequest requestId ──────────────────────────────────────────────

describe('serializeRequest — requestId', () => {
  it('prepends # @id comment when requestId is provided', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000'
    const state = makeState({ method: 'GET', url: 'https://api.com' })
    const output = serializeRequest(state, id)
    expect(output.startsWith(`# @id ${id}\n`)).toBe(true)
  })

  it('does not add # @id comment when requestId is omitted', () => {
    const state = makeState({ method: 'GET', url: 'https://api.com' })
    const output = serializeRequest(state)
    expect(output).not.toContain('@id')
  })
})

// ── serializeRequest settings block ─────────────────────────────────────────

describe('serializeRequest — @settings block', () => {
  it('omits the block entirely when there are no overrides', () => {
    const state = makeState({
      method: 'GET',
      url: 'https://api.com',
      settings: { verifySsl: { inherit: true } }
    })
    expect(serializeRequest(state)).not.toContain('@settings')
  })

  it('includes only overridden fields', () => {
    const state = makeState({
      method: 'GET',
      url: 'https://api.com',
      settings: {
        verifySsl: { inherit: false, value: false },
        maxRedirects: { inherit: false, value: 2 },
        followRedirects: { inherit: true }
      }
    })
    const out = serializeRequest(state)
    expect(out).toContain('# @settings')
    expect(out).toContain('# verifySsl: false')
    expect(out).toContain('# maxRedirects: 2')
    expect(out).not.toContain('# followRedirects')
    expect(out).toContain('# @end-settings')
  })

  // The cookie-jar override has two spellings: `true` keeps the historical
  // `# @disable-cookie-jar` marker, `false` ("use the jar" in a workspace that
  // disables it) can only live in the block. Dropping `false` lost the choice
  // on reopen.
  describe('cookie-jar override', () => {
    const get = (settings: RequestEditorState['settings']): string =>
      serializeRequest(makeState({ method: 'GET', url: 'https://api.com/x', settings }))

    it('writes a "use the jar" override as a block line, without the marker', () => {
      expect(get({ disableCookieJar: { inherit: false, value: false } })).toBe(
        '# @settings\n# disableCookieJar: false\n# @end-settings\nGET https://api.com/x\n'
      )
    })

    it('keeps the marker for a "disable" override, byte-identical, with no block line', () => {
      expect(get({ disableCookieJar: { inherit: false, value: true } })).toBe(
        '# @disable-cookie-jar\nGET https://api.com/x\n'
      )
    })

    it('writes neither when the request inherits', () => {
      expect(get({ disableCookieJar: { inherit: true } })).toBe('GET https://api.com/x\n')
    })

    it('puts the line last in a block shared with other overrides', () => {
      expect(
        get({
          disableCookieJar: { inherit: false, value: false },
          followRedirects: { inherit: false, value: false }
        })
      ).toBe(
        '# @settings\n# followRedirects: false\n# disableCookieJar: false\n# @end-settings\nGET https://api.com/x\n'
      )
    })

    it('keeps the marker and the other overrides when the jar is disabled', () => {
      expect(
        get({
          disableCookieJar: { inherit: false, value: true },
          followRedirects: { inherit: false, value: false }
        })
      ).toBe(
        '# @disable-cookie-jar\n# @settings\n# followRedirects: false\n# @end-settings\nGET https://api.com/x\n'
      )
    })
  })
})
