import { describe, it, expect, vi } from 'vitest'
import { parseHttpFile } from './parser'

// ── Helpers ────────────────────────────────────────────────────────────────

/** Trim leading/trailing whitespace from rawText for easier assertions */
function req(parsed: ReturnType<typeof parseHttpFile>, idx = 0) {
  return parsed.requests[idx]
}

// ── Test suites ────────────────────────────────────────────────────────────

describe('parseHttpFile', () => {
  // ── Simple GET (no body) ─────────────────────────────────────────────────

  it('parses a simple GET request with no body', () => {
    const content = `GET https://api.example.com/users`
    const result = parseHttpFile(content)

    expect(result.requests).toHaveLength(1)
    expect(req(result).method).toBe('GET')
    expect(req(result).url).toBe('https://api.example.com/users')
    expect(req(result).headers).toEqual({})
    expect(req(result).body).toBeUndefined()
  })

  it('ignores the HTTP version on the request line', () => {
    const content = `GET https://api.example.com/users HTTP/1.1`
    const result = parseHttpFile(content)

    expect(result.requests).toHaveLength(1)
    expect(req(result).method).toBe('GET')
    expect(req(result).url).toBe('https://api.example.com/users')
  })

  it('uppercases the HTTP method', () => {
    const content = `get https://api.example.com/users`
    const result = parseHttpFile(content)

    expect(req(result).method).toBe('GET')
  })

  // ── Request with headers ─────────────────────────────────────────────────

  it('parses headers correctly', () => {
    const content = [
      'GET https://api.example.com/me',
      'Authorization: Bearer secret',
      'Accept: application/json'
    ].join('\n')

    const result = parseHttpFile(content)

    expect(req(result).headers).toEqual({
      Authorization: 'Bearer secret',
      Accept: 'application/json'
    })
    expect(req(result).body).toBeUndefined()
  })

  // ── POST with JSON body ──────────────────────────────────────────────────

  it('parses a POST request with a JSON body', () => {
    const content = [
      'POST https://api.example.com/users',
      'Content-Type: application/json',
      '',
      '{"name": "Juan", "email": "juan@test.com"}'
    ].join('\n')

    const result = parseHttpFile(content)

    expect(result.requests).toHaveLength(1)
    expect(req(result).method).toBe('POST')
    expect(req(result).headers['Content-Type']).toBe('application/json')
    expect(req(result).body).toBe('{"name": "Juan", "email": "juan@test.com"}')
  })

  it('preserves trailing blank lines in the body (CA-06), minus the structural terminator', () => {
    // `.http` round-trip fidelity: the body is opaque to boundary — trailing
    // blank lines are content. Exactly one structural newline (the file/block
    // terminator) is removed, so this body keeps its single trailing newline.
    const content = [
      'POST https://api.example.com/users',
      'Content-Type: application/json',
      '',
      '{"name": "Juan"}',
      '',
      ''
    ].join('\n')

    const result = parseHttpFile(content)
    expect(req(result).body).toBe('{"name": "Juan"}\n')
  })

  // ── Multiple requests (### separator) ───────────────────────────────────

  it('parses multiple requests separated by ###', () => {
    const content = [
      'GET https://api.example.com/users',
      '',
      '###',
      '',
      'POST https://api.example.com/users',
      'Content-Type: application/json',
      '',
      '{"name": "Juan"}'
    ].join('\n')

    const result = parseHttpFile(content)

    expect(result.requests).toHaveLength(2)
    expect(req(result, 0).method).toBe('GET')
    expect(req(result, 1).method).toBe('POST')
    expect(req(result, 1).body).toBe('{"name": "Juan"}')
  })

  it('handles ### separator with a label comment', () => {
    const content = [
      'GET https://api.example.com/a',
      '',
      '### Second request',
      '',
      'DELETE https://api.example.com/b'
    ].join('\n')

    const result = parseHttpFile(content)

    expect(result.requests).toHaveLength(2)
    expect(req(result, 0).url).toBe('https://api.example.com/a')
    expect(req(result, 1).method).toBe('DELETE')
    expect(req(result, 1).url).toBe('https://api.example.com/b')
  })

  it('handles three or more requests in one file', () => {
    const content = [
      'GET https://api.example.com/a',
      '###',
      'GET https://api.example.com/b',
      '###',
      'GET https://api.example.com/c'
    ].join('\n')

    const result = parseHttpFile(content)
    expect(result.requests).toHaveLength(3)
  })

  // ── Variables ────────────────────────────────────────────────────────────

  it('detects variables in the URL', () => {
    const content = `GET {{baseUrl}}/api/users`
    const result = parseHttpFile(content)

    expect(result.variablesUsed).toContain('baseUrl')
    expect(req(result).url).toBe('{{baseUrl}}/api/users')
  })

  it('detects variables in headers', () => {
    const content = ['GET https://api.example.com/me', 'Authorization: Bearer {{token}}'].join('\n')

    const result = parseHttpFile(content)
    expect(result.variablesUsed).toContain('token')
  })

  it('detects variables in the body', () => {
    const content = [
      'POST https://api.example.com/login',
      'Content-Type: application/json',
      '',
      '{"password": "{{password}}"}'
    ].join('\n')

    const result = parseHttpFile(content)
    expect(result.variablesUsed).toContain('password')
  })

  it('collects unique variable names across the whole file', () => {
    const content = [
      'GET {{baseUrl}}/users',
      'Authorization: Bearer {{token}}',
      '',
      '###',
      '',
      'POST {{baseUrl}}/users',
      'Authorization: Bearer {{token}}',
      '',
      '{"org": "{{org}}"}'
    ].join('\n')

    const result = parseHttpFile(content)
    expect(result.variablesUsed.sort()).toEqual(['baseUrl', 'org', 'token'])
  })

  // ── Comments ─────────────────────────────────────────────────────────────

  it('ignores # comments before the request line', () => {
    const content = ['# This is a comment', 'GET https://api.example.com/users'].join('\n')

    const result = parseHttpFile(content)
    expect(result.requests).toHaveLength(1)
    expect(req(result).method).toBe('GET')
  })

  it('ignores // comments before the request line', () => {
    const content = ['// Another comment style', 'GET https://api.example.com/users'].join('\n')

    const result = parseHttpFile(content)
    expect(result.requests).toHaveLength(1)
  })

  it('ignores # comments in the headers section', () => {
    const content = [
      'GET https://api.example.com/users',
      '# Authorization header below',
      'Authorization: Bearer secret'
    ].join('\n')

    const result = parseHttpFile(content)
    expect(req(result).headers).toEqual({ Authorization: 'Bearer secret' })
  })

  it('does NOT treat ### as a comment — it is a separator', () => {
    const content = [
      'GET https://api.example.com/a',
      '### separator',
      'GET https://api.example.com/b'
    ].join('\n')

    const result = parseHttpFile(content)
    expect(result.requests).toHaveLength(2)
  })

  // ── Mixed line endings ────────────────────────────────────────────────────

  it('handles CRLF line endings', () => {
    const content =
      'GET https://api.example.com/users\r\nAuthorization: Bearer secret\r\n\r\n{"ok":true}'
    const result = parseHttpFile(content)

    expect(result.requests).toHaveLength(1)
    expect(req(result).method).toBe('GET')
    expect(req(result).headers['Authorization']).toBe('Bearer secret')
    expect(req(result).body).toBe('{"ok":true}')
  })

  it('handles mixed CRLF and LF line endings', () => {
    const content =
      'POST https://api.example.com/users\r\nContent-Type: application/json\n\n{"name":"test"}'
    const result = parseHttpFile(content)

    expect(result.requests).toHaveLength(1)
    expect(req(result).method).toBe('POST')
    expect(req(result).body).toBe('{"name":"test"}')
  })

  it('handles CR-only line endings', () => {
    const content = 'GET https://api.example.com/users\rAccept: application/json'
    const result = parseHttpFile(content)

    expect(result.requests).toHaveLength(1)
    expect(req(result).headers['Accept']).toBe('application/json')
  })

  // ── Edge cases ────────────────────────────────────────────────────────────

  it('returns empty requests for empty content', () => {
    const result = parseHttpFile('')
    expect(result.requests).toHaveLength(0)
    expect(result.variablesUsed).toHaveLength(0)
  })

  it('returns empty requests for content with only comments', () => {
    const content = ['# just a comment', '// another comment'].join('\n')
    const result = parseHttpFile(content)
    expect(result.requests).toHaveLength(0)
  })

  it('includes rawText in each parsed request', () => {
    const content = 'GET https://api.example.com/users'
    const result = parseHttpFile(content)
    expect(req(result).rawText).toBeTruthy()
    expect(req(result).rawText).toContain('GET')
  })

  // ── requestId metadata ────────────────────────────────────────────────────

  it('extracts requestId from # @id comment', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000'
    const content = [`# @id ${id}`, 'GET https://api.example.com/users'].join('\n')
    const result = parseHttpFile(content)
    expect(result.requestId).toBe(id)
  })

  it('returns undefined requestId when no @id comment is present', () => {
    const content = 'GET https://api.example.com/users'
    const result = parseHttpFile(content)
    expect(result.requestId).toBeUndefined()
  })

  it('ignores @id comment with invalid UUID format', () => {
    const content = ['# @id not-a-valid-uuid', 'GET https://api.example.com/users'].join('\n')
    const result = parseHttpFile(content)
    expect(result.requestId).toBeUndefined()
  })

  it('stops searching for @id once a non-comment line is reached', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000'
    const content = ['GET https://api.example.com/users', `# @id ${id}`].join('\n')
    const result = parseHttpFile(content)
    expect(result.requestId).toBeUndefined()
  })

  // ── Pre/post-request scripts ──────────────────────────────────────────────

  it('extracts pre-request script block', () => {
    const content = [
      '# @pre-request-script',
      '# fp.environment.set("token", "abc");',
      '# fp.request.headers.set("Authorization", "Bearer abc");',
      '# @end-script',
      'GET https://api.example.com/me'
    ].join('\n')

    const result = parseHttpFile(content)
    expect(req(result).preRequestScript).toBe(
      [
        'fp.environment.set("token", "abc");',
        'fp.request.headers.set("Authorization", "Bearer abc");'
      ].join('\n')
    )
    expect(req(result).postResponseScript).toBeUndefined()
  })

  it('extracts post-response script block', () => {
    const content = [
      'GET https://api.example.com/me',
      '',
      '# @post-response-script',
      '# fp.test("ok", () => { fp.expect(fp.response.status).to.equal(200); });',
      '# @end-script'
    ].join('\n')

    const result = parseHttpFile(content)
    expect(req(result).preRequestScript).toBeUndefined()
    expect(req(result).postResponseScript).toContain('fp.test("ok"')
  })

  it('extracts both pre and post scripts from the same request', () => {
    const content = [
      '# @pre-request-script',
      '# fp.variables.set("t", 1);',
      '# @end-script',
      'POST https://api.example.com/users',
      'Content-Type: application/json',
      '',
      '{"name":"John"}',
      '',
      '# @post-response-script',
      '# fp.test("created", () => {',
      '#   fp.expect(fp.response.status).to.equal(201);',
      '# });',
      '# @end-script'
    ].join('\n')

    const result = parseHttpFile(content)
    expect(req(result).preRequestScript).toBe('fp.variables.set("t", 1);')
    expect(req(result).postResponseScript).toContain('fp.test("created"')
    expect(req(result).body).toBe('{"name":"John"}')
    expect(req(result).method).toBe('POST')
  })

  it('does not emit script fields when there are no script blocks', () => {
    const content = 'GET https://api.example.com/users'
    const result = parseHttpFile(content)
    expect(req(result).preRequestScript).toBeUndefined()
    expect(req(result).postResponseScript).toBeUndefined()
  })

  // ── @settings block ──────────────────────────────────────────────────────

  it('parses @settings block with overrides', () => {
    const content = [
      '# @settings',
      '# followRedirects: false',
      '# maxRedirects: 3',
      '# verifySsl: false',
      '# httpVersion: http2',
      '# @end-settings',
      'GET https://api.example.com/users'
    ].join('\n')
    const result = parseHttpFile(content)
    expect(req(result).settings).toEqual({
      followRedirects: { inherit: false, value: false },
      maxRedirects: { inherit: false, value: 3 },
      verifySsl: { inherit: false, value: false },
      httpVersion: { inherit: false, value: 'http2' }
    })
  })

  it('returns undefined settings when there is no @settings block', () => {
    const result = parseHttpFile('GET https://api.example.com/users')
    expect(req(result).settings).toBeUndefined()
  })

  it('skips invalid values inside @settings (bad bool)', () => {
    const content = [
      '# @settings',
      '# verifySsl: maybe',
      '# maxRedirects: 5',
      '# @end-settings',
      'GET https://api.example.com/users'
    ].join('\n')
    const result = parseHttpFile(content)
    expect(req(result).settings).toEqual({
      maxRedirects: { inherit: false, value: 5 }
    })
  })

  it('skips unknown httpVersion enum', () => {
    const content = [
      '# @settings',
      '# httpVersion: quic',
      '# @end-settings',
      'GET https://api.example.com/users'
    ].join('\n')
    const result = parseHttpFile(content)
    expect(req(result).settings).toBeUndefined()
  })

  // ── @rawSubtype marker ────────────────────────────────────────────────────

  it('parses `# @rawSubtype: xml` from the body section', () => {
    const content = [
      'POST https://api.example.com/users',
      'Content-Type: application/xml',
      '',
      '# @rawSubtype: xml',
      '<user><name>Juan</name></user>'
    ].join('\n')
    const result = parseHttpFile(content)
    expect(req(result).rawSubtype).toBe('xml')
    expect(req(result).body).toBe('<user><name>Juan</name></user>')
  })

  it('accepts all valid raw subtypes', () => {
    for (const sub of ['json', 'xml', 'javascript', 'text', 'html']) {
      const content = [
        'POST https://api.example.com/x',
        '',
        `# @rawSubtype: ${sub}`,
        'body-content'
      ].join('\n')
      const result = parseHttpFile(content)
      expect(req(result).rawSubtype).toBe(sub)
      expect(req(result).body).toBe('body-content')
    }
  })

  it('ignores unknown `# @rawSubtype:` values and keeps the line in the body', () => {
    const content = ['POST https://api.example.com/x', '', '# @rawSubtype: yaml', 'real body'].join(
      '\n'
    )
    const result = parseHttpFile(content)
    expect(req(result).rawSubtype).toBeUndefined()
    // The unrecognized marker stays as a body line.
    expect(req(result).body).toContain('# @rawSubtype: yaml')
    expect(req(result).body).toContain('real body')
  })

  it('returns undefined rawSubtype when no marker is present', () => {
    const content = ['POST https://api.example.com/x', '', '{"ok":true}'].join('\n')
    const result = parseHttpFile(content)
    expect(req(result).rawSubtype).toBeUndefined()
  })

  it('only honours `# @rawSubtype:` when it is the first body line', () => {
    const content = [
      'POST https://api.example.com/x',
      '',
      'first body line',
      '# @rawSubtype: xml'
    ].join('\n')
    const result = parseHttpFile(content)
    expect(req(result).rawSubtype).toBeUndefined()
    expect(req(result).body).toContain('# @rawSubtype: xml')
  })
})

// ── REQ-0113 §6.6 — a malformed percent-escape never takes the file down ────
//
// The auth-echo reconciliation percent-decodes each query parameter name to
// find the one the scheme owns. That decode used to throw straight out of
// `parseHttpFile`, so a single stray `%` made the request unopenable on the
// desktop and aborted the run in the CLI. Containment now lives in the token
// grammar; here we pin the observable consequence.
describe('REQ-0113 — malformed query parameter names do not abort the parse', () => {
  const authBlock = [
    '# @auth',
    '# type: api-key',
    '# key: api_key',
    '# value: {{apiKey}}',
    '# location: query',
    '# @end-auth'
  ]

  it('CA-08: the file parses and the malformed parameter keeps its author bytes', () => {
    const content = [...authBlock, '', 'GET https://api.example.com/x?%E0=v&api_key=zzz'].join('\n')

    expect(() => parseHttpFile(content)).not.toThrow()
    const parsed = parseHttpFile(content)
    // The scheme still owns (and strips) its own parameter…
    expect(req(parsed).url).not.toContain('api_key=zzz')
    // …while the undecodable one survives verbatim rather than taking the parse
    // with it. It is simply not recognized as this scheme's echo.
    expect(req(parsed).url).toContain('%E0=v')
  })

  it('CA-10: one bad parameter does not invalidate the rest of the file', () => {
    // Two independent survival checks, because the parse result carries the
    // requests twice: as a parsed list, and as the verbatim `tail` the editing
    // surface re-emits byte-for-byte on save. A malformed parameter in the first
    // request must take down neither.
    const tail = [
      '### second',
      'GET https://api.example.com/second?ok=1',
      '',
      '### third',
      'POST https://api.example.com/third',
      ''
    ].join('\n')
    const first = [
      ...authBlock,
      '',
      'GET https://api.example.com/first?%E0=v&api_key=zzz',
      ''
    ].join('\n')

    const parsed = parseHttpFile(first + '\n' + tail)
    expect(req(parsed).url).toContain('%E0=v')
    // Every request in the file loaded — not just the one carrying the bad param.
    expect(parsed.requests).toHaveLength(3)
    expect(req(parsed, 1).url).toBe('https://api.example.com/second?ok=1')
    expect(req(parsed, 2).method).toBe('POST')
    // …and the verbatim tail is byte-exact, so a save re-emits them untouched.
    expect(parsed.tail).toBe(tail)
  })

  it('a malformed escape in a DISABLED row survives the same way', () => {
    // `parseDisabledRow` shares the decode seam and was a third unguarded site.
    const content = ['GET https://api.example.com/x', '# @disabled param 0 %E0=v', ''].join('\n')
    expect(() => parseHttpFile(content)).not.toThrow()
  })
})

describe('parseHttpFile — load-time diagnostics (CLI readiness)', () => {
  it('reports diagnostics in the result instead of the process console', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const parsed = parseHttpFile(
      [
        '# @settings',
        '# bogusKey: 1',
        '# verifySsl: maybe',
        '# @end-settings',
        '',
        'GET https://x/'
      ].join('\n')
    )
    expect(parsed.requests).toHaveLength(1)
    expect(parsed.warnings).toEqual([
      'unknown # @settings key "bogusKey"',
      expect.stringContaining('invalid # @settings value for "verifySsl"')
    ])
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('a clean file carries no warnings field', () => {
    expect(parseHttpFile('GET https://x/\n').warnings).toBeUndefined()
  })

  it('diagnostics do not leak from one parse into the next', () => {
    parseHttpFile('# @settings\n# bogusKey: 1\n# @end-settings\n\nGET https://x/\n')
    expect(parseHttpFile('GET https://x/\n').warnings).toBeUndefined()
  })
})

// Each request carries the diagnostics a save of **that** request would act on
// (drop or rewrite) — the desktop shows them and marks the tab modified. The
// file-level list keeps every diagnostic for the command line.
describe('parseHttpFile — per-request load warnings', () => {
  const REF = `${'a'.repeat(64)}__photo.png`
  const first = (content: string) => parseHttpFile(content).requests[0]

  it.each([
    [
      'a malformed # @auth block',
      '# @auth\n# type: digest\n# @end-auth\nGET https://x/\n',
      /invalid # @auth block/
    ],
    [
      'an unterminated # @auth block',
      '# @auth\n# type: bearer\nGET https://x/\n',
      /missing "# @end-auth"/
    ],
    [
      'an unknown # @settings key',
      '# @settings\n# bogusKey: 1\n# @end-settings\nGET https://x/\n',
      /unknown # @settings key "bogusKey"/
    ],
    [
      'an invalid # @settings value',
      '# @settings\n# verifySsl: maybe\n# @end-settings\nGET https://x/\n',
      /invalid # @settings value for "verifySsl"/
    ],
    [
      'a binary reference beside a body',
      `# @binary-file: ${REF}\nPOST https://x/\n\nbody text\n`,
      /the body is discarded/
    ],
    [
      'an unknown multipart attribute',
      'POST https://x/\n\n# @multipart begin\n# @multipart-part name=a type=text rogue=1\nv\n# @multipart end\n',
      /unknown attribute "rogue"/
    ],
    [
      'an invalid multipart text part',
      'POST https://x/\n\n# @multipart begin\n# @multipart-part type=text\nv\n# @multipart end\n',
      /missing required attribute "name"/
    ]
  ])('%s is a load warning of its request', (_label, content, pattern) => {
    const r = first(content)
    expect(r.loadWarnings).toEqual([expect.stringMatching(pattern)])
    expect(parseHttpFile(content).warnings).toEqual(r.loadWarnings)
  })

  it('a clean request carries none', () => {
    expect(first('GET https://x/\n').loadWarnings).toBeUndefined()
  })

  it('warnings stay with the request that produced them', () => {
    const parsed = parseHttpFile(
      'GET https://x/one\n\n###\n# @settings\n# bogusKey: 1\n# @end-settings\nGET https://x/two\n'
    )
    expect(parsed.requests[0].loadWarnings).toBeUndefined()
    expect(parsed.requests[1].loadWarnings).toEqual(['unknown # @settings key "bogusKey"'])
    expect(parsed.warnings).toEqual(['unknown # @settings key "bogusKey"'])
  })

  it('an invalid binary reference is kept by a save, so it is not a load warning of the request', () => {
    const content = '# @binary-file: not-a-ref\nPOST https://x/\n'
    const r = first(content)
    expect(r.invalidBinaryRef).toBe('not-a-ref')
    expect(r.loadWarnings).toBeUndefined()
    expect(parseHttpFile(content).warnings).toEqual([expect.stringContaining('not-a-ref')])
  })

  it('an invalid binary reference beside a body drops the body, with a load warning', () => {
    const content = '# @binary-file: not-a-ref\nPOST https://x/\n\nbody text\n'
    const r = first(content)
    expect(r.invalidBinaryRef).toBe('not-a-ref')
    expect(r.body).toBeUndefined()
    expect(r.loadWarnings).toEqual([expect.stringMatching(/the body is discarded/)])
  })

  it('an invalid multipart file part is carried by its parseError, not a load warning', () => {
    const content =
      'POST https://x/\n\n# @multipart begin\n# @multipart-part name=f type=file file=bad\n# @multipart end\n'
    const r = first(content)
    expect(r.multipartParts?.[0]).toMatchObject({ kind: 'file', parseError: expect.any(String) })
    expect(r.loadWarnings).toBeUndefined()
    expect(parseHttpFile(content).warnings).toEqual([expect.stringMatching(/invalid file ref/)])
  })
})
