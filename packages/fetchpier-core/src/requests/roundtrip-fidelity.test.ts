import { describe, it, expect } from 'vitest'
import type { RequestEditorState, KeyValuePair, MultipartPart } from '@shared/types'
import { serializeRequest, splitUrlAndParams } from '@shared/lib/http-serializer'
import { getAllHeaders } from '@shared/lib/headers'
import { parseHttpFile } from './parser'

/**
 * Adversarial `.http` round-trip fidelity suite (`serialize → parse → map`).
 *
 * Phase A (header contract) slice: duplicate header names and header order must
 * survive parse → serialize → parse. Later phases append body/request-line,
 * disabled-row, comment, and full-field cases here.
 */

function kv(key: string, value: string, enabled = true): KeyValuePair {
  return { id: `${key}-${value}`, key, value, enabled }
}

function editorState(overrides: Partial<RequestEditorState>): RequestEditorState {
  return {
    method: 'GET',
    url: 'https://api.example.com/things',
    params: [],
    headers: [],
    bodyType: 'none',
    rawSubtype: 'json',
    body: '',
    formFields: [],
    auth: { type: 'none' },
    preRequestScript: '',
    postResponseScript: '',
    settings: {},
    ...overrides
  }
}

describe('round-trip fidelity — headers (CA-03)', () => {
  it('preserves duplicate header names through serialize → parse, in author order', () => {
    const state = editorState({
      headers: [kv('Accept', 'application/json'), kv('Accept', 'text/html'), kv('X-Custom', 'a')]
    })

    const text = serializeRequest(state)
    const { requests } = parseHttpFile(text)
    const req = requests[0]

    expect(req.headerList).toBeDefined()
    expect(getAllHeaders(req.headerList!, 'Accept')).toEqual(['application/json', 'text/html'])
    // Order across distinct names is preserved too.
    expect(req.headerList!.map((h) => h.name)).toEqual(['Accept', 'Accept', 'X-Custom'])
  })

  it('parses repeated header names from raw .http text into an ordered list', () => {
    const text = [
      'GET https://api.example.com/things',
      'X-Trace: 1',
      'X-Trace: 2',
      'X-Trace: 3',
      ''
    ].join('\n')

    const { requests } = parseHttpFile(text)
    expect(getAllHeaders(requests[0].headerList!, 'X-Trace')).toEqual(['1', '2', '3'])
  })

  it('keeps headers (record) as the lossy last-wins convenience view', () => {
    const text = ['GET https://api.example.com/things', 'X-Trace: 1', 'X-Trace: 2', ''].join('\n')
    const { requests } = parseHttpFile(text)
    // The map collapses duplicates (documented behavior); the list does not.
    expect(requests[0].headers['X-Trace']).toBe('2')
    expect(getAllHeaders(requests[0].headerList!, 'X-Trace')).toEqual(['1', '2'])
  })
})

describe('round-trip fidelity — body & request line (Phase B)', () => {
  it('CA-01: a ### line not followed by a request line survives in the body', () => {
    const text = [
      'POST https://api.example.com/notes',
      'Content-Type: text/markdown',
      '',
      '# Title',
      '',
      '### A heading inside the body',
      'Some prose, not a request.'
    ].join('\n')
    const { requests } = parseHttpFile(text)
    expect(requests).toHaveLength(1)
    expect(requests[0].body).toContain('### A heading inside the body')
    expect(requests[0].body).toContain('Some prose, not a request.')
  })

  it('CA-02: a directive-looking line in the body is content, not extracted', () => {
    const text = [
      'POST https://api.example.com/x',
      'Content-Type: text/plain',
      '',
      '# @pre-request-script',
      '# fp.environment.set("x", 1)',
      '# @end-script',
      '# @rawSubtype: xml',
      '# @disabled header 0 X: y'
    ].join('\n')
    const { requests } = parseHttpFile(text)
    const r = requests[0]
    // No configuration injected — the body keeps the lines verbatim.
    expect(r.preRequestScript).toBeUndefined()
    expect(r.body).toContain('# @pre-request-script')
    expect(r.body).toContain('# @rawSubtype: xml')
    expect(r.body).toContain('# @disabled header 0 X: y')
  })

  it('CA-05: header value whitespace is stable; empty value normalizes', () => {
    const state = editorState({
      headers: [kv('X-Pad', '  spaced  '), kv('X-Empty', '')]
    })
    const text = serializeRequest(state)
    const { requests } = parseHttpFile(text)
    // Byte-stable: the serializer writes one separator space, the parser strips
    // exactly one — so the author's leading/trailing whitespace survives intact.
    expect(getAllHeaders(requests[0].headerList!, 'X-Pad')).toEqual(['  spaced  '])
    // Empty value normalizes to the uniform `Name: ` separator → parses back to ''.
    expect(getAllHeaders(requests[0].headerList!, 'X-Empty')).toEqual([''])
  })

  it('CA-06: body blank lines and the final newline round-trip distinctly', () => {
    for (const body of ['line1\n\nline3', 'trailing\n', 'no-trailing']) {
      const state = editorState({ method: 'POST', bodyType: 'raw', rawSubtype: 'text', body })
      const reparsed = parseHttpFile(serializeRequest(state)).requests[0]
      expect(reparsed.body).toBe(body)
    }
  })

  it('CA-07: a URL with a literal space is preserved verbatim', () => {
    const text = 'GET https://api.example.com/search?q=a b c HTTP/1.1\n'
    const { requests } = parseHttpFile(text)
    expect(requests[0].url).toBe('https://api.example.com/search?q=a b c')
    // And it round-trips through the editor state.
    const state = editorState({ url: 'https://api.example.com/a b' })
    expect(parseHttpFile(serializeRequest(state)).requests[0].url).toBe(
      'https://api.example.com/a b'
    )
  })

  it('CA-09: a multi-request file preserves every request; tail is byte-exact', () => {
    const first = ['GET https://a/1', 'X-One: 1', ''].join('\n')
    const tail = ['### second', 'GET https://a/2', '', '### third', 'POST https://a/3', ''].join(
      '\n'
    )
    const file = first + '\n' + tail
    const parsed = parseHttpFile(file)
    expect(parsed.requests).toHaveLength(3)
    expect(parsed.tail).toBe(tail)
    // The editing surface edits the first and re-emits the tail verbatim.
    const reEmitted = serializeRequest(parseFirstAsState(parsed.requests[0])) + parsed.tail
    expect(parseHttpFile(reEmitted).requests).toHaveLength(3)
  })

  it('CA-12: pre/post scripts round-trip in the metadata region', () => {
    const state = editorState({
      preRequestScript: 'fp.environment.set("a", 1)',
      postResponseScript: 'fp.test("ok", () => fp.expect(fp.response.status).to.equal(200))',
      bodyType: 'raw',
      rawSubtype: 'json',
      body: '{"x":1}'
    })
    const text = serializeRequest(state)
    // Both scripts are written before the request line (metadata region).
    const reqLineIdx = text.split('\n').findIndex((l) => l.startsWith('GET '))
    const postIdx = text.split('\n').findIndex((l) => l.includes('@post-response-script'))
    expect(postIdx).toBeGreaterThanOrEqual(0)
    expect(postIdx).toBeLessThan(reqLineIdx)
    const r = parseHttpFile(text).requests[0]
    expect(r.preRequestScript).toBe(state.preRequestScript)
    expect(r.postResponseScript).toBe(state.postResponseScript)
    expect(r.body).toBe('{"x":1}')
  })

  it('CA-12: an old trailing post-response script is recovered, not folded into the body', () => {
    const text = [
      'POST https://a/x',
      'Content-Type: application/json',
      '',
      '{"x":1}',
      '',
      '# @post-response-script',
      '# fp.environment.set("token", fp.response.json().token)',
      '# @end-script'
    ].join('\n')
    const r = parseHttpFile(text).requests[0]
    expect(r.postResponseScript).toBe('fp.environment.set("token", fp.response.json().token)')
    expect(r.body).toBe('{"x":1}')
    expect(r.body).not.toContain('@post-response-script')
  })
})

describe('round-trip fidelity — disabled rows (Phase C)', () => {
  it('CA-04: a disabled header / param / field round-trips at its position', () => {
    const state = editorState({
      method: 'POST',
      url: 'https://api.example.com/x',
      params: [kv('a', '1'), kv('b', '2', false), kv('c', '3')],
      headers: [kv('X-One', '1'), kv('X-Two', '2', false), kv('X-Three', '3')],
      bodyType: 'x-www-form-urlencoded',
      formFields: [kv('f1', 'v1'), kv('f2', 'v2', false)]
    })
    const text = serializeRequest(state)
    // Disabled rows are written as inert `# @disabled` comments in metadata.
    expect(text).toContain('# @disabled header 1 X-Two: 2')
    expect(text).toContain('# @disabled param 1 b=2')
    expect(text).toContain('# @disabled field 1 f2=v2')

    const r = parseHttpFile(text).requests[0]
    // Wire-bound sets hold only the enabled rows.
    expect(r.headerList!.map((h) => h.name)).toEqual(['X-One', 'X-Three'])
    // Disabled rows are carried separately, with their positions.
    expect(r.disabledRows).toEqual([
      { kind: 'header', pos: 1, key: 'X-Two', value: '2' },
      { kind: 'param', pos: 1, key: 'b', value: '2' },
      { kind: 'field', pos: 1, key: 'f2', value: 'v2' }
    ])
  })
})

describe('round-trip fidelity — query, malformed part, capstone (Phase C)', () => {
  it('CA-08: query values encode/decode token-aware and round-trip byte-exact', () => {
    const state = editorState({
      url: 'https://api.example.com/s',
      params: [
        kv('path', 'a/b'),
        kv('amp', 'x&y'),
        kv('space', 'a b'),
        kv('plus', 'a+b'),
        kv('tok', '{{q}}')
      ]
    })
    const r = parseHttpFile(serializeRequest(state)).requests[0]
    // splitUrlAndParams decodes back to the editor values — byte-exact.
    const params = splitUrlAndParams(r.url).params
    expect(params.map((p) => [p.key, p.value])).toEqual([
      ['path', 'a/b'],
      ['amp', 'x&y'],
      ['space', 'a b'],
      ['plus', 'a+b'],
      ['tok', '{{q}}']
    ])
  })

  // Built from what the parser actually produces for a file part whose
  // reference it cannot accept — not a hand-made shape: the parser used to
  // downgrade such a part to a text part, which no `parseError` filter catches,
  // so the save rewrote it as `type=text` instead of removing it.
  it.each([
    ['an invalid reference', 'file=bad-ref'],
    ['a variable reference', 'file={{uploadRef}}'],
    ['no reference', '']
  ])(
    'CA-11: a multipart file part with %s is removed on save, never rewritten as text',
    (_l, attr) => {
      const file = [
        'POST https://api.example.com/upload',
        '',
        '# @multipart begin',
        '# @multipart-part name=ok type=text',
        'v',
        `# @multipart-part name=broken type=file ${attr}`.trim(),
        '# @multipart end',
        ''
      ].join('\n')
      const parts: MultipartPart[] = parseHttpFile(file).requests[0].multipartParts!
      expect(parts[1]).toMatchObject({
        kind: 'file',
        name: 'broken',
        parseError: expect.any(String)
      })

      const text = serializeRequest(
        editorState({ method: 'POST', bodyType: 'multipart-form', multipartParts: parts })
      )
      expect(text).toContain('name=ok')
      expect(text).not.toContain('broken')
      expect(text).not.toContain('bad-ref')
      expect(text).not.toContain('uploadRef')
    }
  )

  it('CA-10: comments are preserved; a stray line is flagged and removed', () => {
    const text = [
      'GET https://api.example.com/x',
      '# a comment above a header',
      'X-One: 1',
      'this is a stray line',
      ''
    ].join('\n')
    const r = parseHttpFile(text).requests[0]
    expect(r.comments).toContain('# a comment above a header')
    expect(r.headerList!.map((h) => h.name)).toEqual(['X-One'])
    expect(r.normalizedOnLoad).toBe(true)
  })

  it('CA-10: comments round-trip as a block in the metadata region', () => {
    const state = editorState({ comments: ['# note one', '# note two'], headers: [kv('X', '1')] })
    const text = serializeRequest(state)
    // Comments sit before the request line.
    const reqIdx = text.split('\n').findIndex((l) => l.startsWith('GET '))
    const noteIdx = text.split('\n').findIndex((l) => l === '# note one')
    expect(noteIdx).toBeGreaterThanOrEqual(0)
    expect(noteIdx).toBeLessThan(reqIdx)
    expect(parseHttpFile(text).requests[0].comments).toEqual(['# note one', '# note two'])
  })

  it('CA-14: a request exercising every field round-trips equivalently', () => {
    const state = editorState({
      method: 'PUT',
      url: 'https://api.example.com/items',
      params: [kv('a', '1'), kv('b', '2', false)],
      headers: [
        kv('Accept', 'application/json'),
        kv('Accept', 'text/html'),
        kv('X-Off', 'z', false)
      ],
      bodyType: 'raw',
      rawSubtype: 'json',
      body: '{"k":1}',
      preRequestScript: 'fp.environment.set("a", 1)',
      postResponseScript: 'fp.test("ok", () => fp.expect(1).to.equal(1))',
      settings: { followRedirects: { inherit: false, value: false } },
      auth: { type: 'bearer', token: '{{token}}' }
    })
    const r = parseHttpFile(serializeRequest(state, 'req-id')).requests[0]
    expect(r.method).toBe('PUT')
    expect(getAllHeaders(r.headerList!, 'Accept')).toEqual(['application/json', 'text/html'])
    expect(r.disabledRows).toEqual([
      { kind: 'header', pos: 2, key: 'X-Off', value: 'z' },
      { kind: 'param', pos: 1, key: 'b', value: '2' }
    ])
    expect(r.body).toBe('{"k":1}')
    expect(r.rawSubtype).toBe('json')
    expect(r.preRequestScript).toBe('fp.environment.set("a", 1)')
    expect(r.postResponseScript).toContain('fp.test')
    expect(r.settings?.followRedirects).toEqual({ inherit: false, value: false })
    expect(r.auth).toEqual({ type: 'bearer', token: '{{token}}' })
  })
})

describe('round-trip fidelity — cookie-jar override', () => {
  it('a "use the jar" override comes back from the settings block', () => {
    const text = serializeRequest(
      editorState({ settings: { disableCookieJar: { inherit: false, value: false } } })
    )
    const r = parseHttpFile(text).requests[0]
    expect(r.settings?.disableCookieJar).toEqual({ inherit: false, value: false })
    expect(r.disableCookieJar).toBeUndefined()
    expect(parseHttpFile(text).warnings ?? []).toEqual([])
  })

  it('a "disable" override still round-trips through the marker', () => {
    const r = parseHttpFile(
      serializeRequest(
        editorState({ settings: { disableCookieJar: { inherit: false, value: true } } })
      )
    ).requests[0]
    expect(r.disableCookieJar).toBe(true)
    expect(r.settings).toBeUndefined()
  })

  it('a "use the jar" override survives next to other overrides', () => {
    const r = parseHttpFile(
      serializeRequest(
        editorState({
          settings: {
            followRedirects: { inherit: false, value: false },
            disableCookieJar: { inherit: false, value: false }
          }
        })
      )
    ).requests[0]
    expect(r.settings).toEqual({
      followRedirects: { inherit: false, value: false },
      disableCookieJar: { inherit: false, value: false }
    })
  })
})

/** Map a parsed request back to a minimal editor state for re-serialization. */
describe('round-trip fidelity — a ### above the first request line (FMT-03)', () => {
  // The editing surface: the first request into the editor state, then a save
  // writes it followed by the verbatim tail.
  function save(text: string): string {
    const parsed = parseHttpFile(text)
    const req = parsed.requests[0]
    const state = editorState({
      ...parseFirstAsState(req),
      auth: req.auth ?? { type: 'none' },
      preRequestScript: req.preRequestScript ?? '',
      postResponseScript: req.postResponseScript ?? '',
      comments: req.comments,
      ...(req.body !== undefined
        ? { bodyType: 'raw' as const, rawSubtype: req.rawSubtype ?? 'text', body: req.body }
        : {})
    })
    return serializeRequest(state, parsed.requestId) + (parsed.tail ?? '')
  }

  const ID = '9e3a4f72-1234-4abc-9def-0123456789ab'

  it('a leading ### title stays a comment of the only request', () => {
    const text = '### Login\nGET https://api.example.com/x\n'
    const parsed = parseHttpFile(text)
    expect(parsed.requests).toHaveLength(1)
    expect(parsed.requests[0].comments).toEqual(['### Login'])
    expect(parsed.tail).toBeUndefined()

    const saved = save(text)
    expect(saved.match(/GET https:\/\/api\.example\.com\/x/g)).toHaveLength(1)
    // load → save → load → save is stable.
    expect(save(saved)).toBe(saved)
  })

  it('metadata, then ###, then the request keeps auth and the script and writes the request once', () => {
    const text = [
      `# @id ${ID}`,
      '# @auth',
      '# type: bearer',
      '# token: abc',
      '# @end-auth',
      '# @pre-request-script',
      '# fp.environment.set("a", 1)',
      '# @end-script',
      '### Login',
      'POST https://api.example.com/login',
      'Content-Type: application/json',
      '',
      '{ "a": 1 }',
      ''
    ].join('\n')
    const r = parseHttpFile(text).requests[0]
    expect(r.auth).toMatchObject({ type: 'bearer' })
    expect(r.preRequestScript).toBe('fp.environment.set("a", 1)')
    expect(parseHttpFile(text).tail).toBeUndefined()

    const saved = save(text)
    expect(saved.match(/POST https:\/\/api\.example\.com\/login/g)).toHaveLength(1)
    const reloaded = parseHttpFile(saved)
    expect(reloaded.requests).toHaveLength(1)
    expect(reloaded.requestId).toBe(ID)
    expect(reloaded.requests[0].auth).toMatchObject({ type: 'bearer' })
    expect(reloaded.requests[0].preRequestScript).toBe('fp.environment.set("a", 1)')
    expect(reloaded.requests[0].comments).toEqual(['### Login'])
    expect(save(saved)).toBe(saved)
  })

  it('comments, then ###, then the request keep every comment', () => {
    const text = [
      '# first note',
      '// second note',
      '###',
      'GET https://api.example.com/x',
      ''
    ].join('\n')
    const r = parseHttpFile(text).requests[0]
    expect(r.comments).toEqual(['# first note', '// second note', '###'])
    const saved = save(text)
    expect(saved.match(/GET https:\/\/api\.example\.com\/x/g)).toHaveLength(1)
    expect(save(saved)).toBe(saved)
  })

  it('a leading ### title in a multi-request file: every request kept once, tail from the next ###', () => {
    const tail = '### two\nGET https://a/2\n'
    const text = '### one\nGET https://a/1\n\n' + tail
    const parsed = parseHttpFile(text)
    expect(parsed.requests.map((r) => r.url)).toEqual(['https://a/1', 'https://a/2'])
    expect(parsed.tail).toBe(tail)
    const saved = save(text)
    expect(saved.match(/GET https:\/\/a\/1/g)).toHaveLength(1)
    expect(saved.match(/GET https:\/\/a\/2/g)).toHaveLength(1)
    expect(parseHttpFile(saved).requests.map((r) => r.url)).toEqual(['https://a/1', 'https://a/2'])
  })
})

function parseFirstAsState(req: {
  method: string
  url: string
  headerList?: { name: string; value: string }[]
}): RequestEditorState {
  return editorState({
    method: req.method,
    url: req.url,
    headers: (req.headerList ?? []).map((h, idx) => ({
      id: `h-${idx}`,
      key: h.name,
      value: h.value,
      enabled: true
    }))
  })
}

describe('round-trip fidelity — value-less query params (REQ-0124)', () => {
  function flag(key: string, enabled = true): KeyValuePair {
    return { id: `f-${key}`, key, value: '', enabled, valueless: true }
  }

  it('serialize → parse → split preserves the authored `=`, or its absence, per param', () => {
    const state = editorState({
      url: 'https://api.example.com/s',
      params: [flag('a'), kv('b', ''), kv('c', '1')]
    })
    const text = serializeRequest(state)
    expect(text).toContain('GET https://api.example.com/s?a&b=&c=1')

    const r = parseHttpFile(text).requests[0]
    const params = splitUrlAndParams(r.url).params
    expect(params.map((p) => [p.key, p.value, Boolean(p.valueless)])).toEqual([
      ['a', '', true],
      ['b', '', false],
      ['c', '1', false]
    ])
    // Re-serializing the reloaded request reproduces the same bytes (idempotent).
    expect(serializeRequest(editorState({ url: 'https://api.example.com/s', params }))).toBe(text)
  })

  it('a disabled value-less param round-trips at its position, still flagged', () => {
    const state = editorState({
      url: 'https://api.example.com/x',
      params: [kv('a', '1'), flag('wsdl', false), kv('c', '3')]
    })
    const text = serializeRequest(state)
    expect(text).toContain('# @disabled param 1 wsdl')
    expect(text).not.toContain('# @disabled param 1 wsdl=')

    const r = parseHttpFile(text).requests[0]
    expect(r.disabledRows).toEqual([
      { kind: 'param', pos: 1, key: 'wsdl', value: '', valueless: true }
    ])
  })
})
