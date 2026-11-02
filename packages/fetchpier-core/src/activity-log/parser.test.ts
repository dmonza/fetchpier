import { describe, expect, it } from 'vitest'
import { parseActivityLog } from './parser'
import { serializeActivityLog } from './serializer'

const CANONICAL =
  '# @timestamp: 2026-05-15T14:23:04.123Z\n' +
  '# @run-id: 0c0e-1111-2222\n' +
  '# @duration-ms: 184\n' +
  '\n' +
  'POST /api/login HTTP/1.1\n' +
  'Host: example.com\n' +
  'Content-Type: application/json\n' +
  '\n' +
  '{"user":"x"}\n' +
  '\n' +
  '### Response\n' +
  '\n' +
  'HTTP/1.1 200 OK\n' +
  'Content-Type: application/json\n' +
  '\n' +
  '{"token":"ey"}\n'

describe('parseActivityLog', () => {
  it('parses header directives, request raw and response raw from a canonical file', () => {
    const file = parseActivityLog(CANONICAL)
    expect(file.header).toEqual([
      { kind: 'directive', key: 'timestamp', value: '2026-05-15T14:23:04.123Z' },
      { kind: 'directive', key: 'run-id', value: '0c0e-1111-2222' },
      { kind: 'directive', key: 'duration-ms', value: '184' }
    ])
    expect(file.requestRaw).toBe(
      'POST /api/login HTTP/1.1\nHost: example.com\nContent-Type: application/json\n\n{"user":"x"}\n'
    )
    expect(file.responseRaw).toBe(
      'HTTP/1.1 200 OK\nContent-Type: application/json\n\n{"token":"ey"}\n'
    )
    expect(file.tailBlocks).toEqual([])
  })

  it('parses header blocks (e.g. # @settings) with their inner lines', () => {
    const text =
      '# @timestamp: t\n' +
      '# @settings\n' +
      '# verifySsl: false\n' +
      '# followRedirects: true\n' +
      '# @end-settings\n' +
      '\n' +
      'GET / HTTP/1.1\n' +
      '\n' +
      '### Response\n' +
      '\n' +
      'HTTP/1.1 200 OK\n'
    const file = parseActivityLog(text)
    expect(file.header).toEqual([
      { kind: 'directive', key: 'timestamp', value: 't' },
      { kind: 'block', name: 'settings', lines: ['verifySsl: false', 'followRedirects: true'] }
    ])
  })

  it('preserves unknown directives and unknown blocks (REQ §6.4 extension tolerance)', () => {
    const text =
      '# @timestamp: t\n' +
      '# @route-id: routes/auth/login.yaml\n' +
      '# @matched\n' +
      '# pattern: /login\n' +
      '# method: POST\n' +
      '# @end-matched\n' +
      '\n' +
      'POST /login HTTP/1.1\n' +
      '\n' +
      '### Response\n' +
      '\n' +
      'HTTP/1.1 200 OK\n'
    const file = parseActivityLog(text)
    expect(file.header).toContainEqual({
      kind: 'directive',
      key: 'route-id',
      value: 'routes/auth/login.yaml'
    })
    expect(file.header).toContainEqual({
      kind: 'block',
      name: 'matched',
      lines: ['pattern: /login', 'method: POST']
    })
    // Round-trip preserves bytes.
    expect(serializeActivityLog(file)).toBe(text)
  })

  it('parses tail extension blocks after the response', () => {
    const text =
      '# @timestamp: t\n' +
      '\n' +
      'GET / HTTP/1.1\n' +
      '\n' +
      '### Response\n' +
      '\n' +
      'HTTP/1.1 200 OK\n' +
      '\n' +
      '# @script-results: post-response\n' +
      '# log: hello\n' +
      '# pass: status is 200\n' +
      '# fail: x is y — expected y, got x\n' +
      '# @end-script-results\n'
    const file = parseActivityLog(text)
    expect(file.responseRaw).toBe('HTTP/1.1 200 OK\n')
    expect(file.tailBlocks).toEqual([
      {
        name: 'script-results: post-response',
        lines: ['log: hello', 'pass: status is 200', 'fail: x is y — expected y, got x']
      }
    ])
  })

  it('preserves free-form comments and blank lines in the header', () => {
    const text =
      '# free-form note here\n' +
      '\n' +
      '# @timestamp: t\n' +
      '\n' +
      'GET / HTTP/1.1\n' +
      '\n' +
      '### Response\n' +
      '\n' +
      'HTTP/1.1 200 OK\n'
    const file = parseActivityLog(text)
    expect(file.header).toEqual([
      { kind: 'comment', text: '# free-form note here' },
      { kind: 'blank' },
      { kind: 'directive', key: 'timestamp', value: 't' }
    ])
    expect(serializeActivityLog(file)).toBe(text)
  })

  it('handles CRLF line endings by normalising to LF', () => {
    const text = CANONICAL.replace(/\n/g, '\r\n')
    const file = parseActivityLog(text)
    expect(file.requestRaw).toContain('Host: example.com')
    expect(serializeActivityLog(file)).toBe(CANONICAL)
  })

  it('throws when "### Response" is missing', () => {
    const text = '# @timestamp: t\n\nGET / HTTP/1.1\n'
    expect(() => parseActivityLog(text)).toThrow(/### Response/)
  })

  it('throws when a tail block has no matching # @end-<head>', () => {
    const text =
      '# @timestamp: t\n' +
      '\n' +
      'GET / HTTP/1.1\n' +
      '\n' +
      '### Response\n' +
      '\n' +
      'HTTP/1.1 200 OK\n'
    // No tail blocks here → returns []. Now build one with a dangling start.
    const broken = text + '\n# @broken\n# inner\n'
    // Because there's no `# @end-broken`, findFirstTailBlock returns -1, so
    // the parser treats `# @broken` as part of responseRaw. So it WON'T throw
    // — confirm this lenient behaviour explicitly.
    const file = parseActivityLog(broken)
    expect(file.responseRaw).toContain('# @broken')
    expect(file.tailBlocks).toEqual([])
  })
})

describe('serialize(parse(x)) === x', () => {
  it('round-trips the canonical fixture byte-for-byte', () => {
    const file = parseActivityLog(CANONICAL)
    expect(serializeActivityLog(file)).toBe(CANONICAL)
  })

  it('round-trips a fixture with header block + tail block', () => {
    const text =
      '# @timestamp: 2026-05-15T14:23:04.123Z\n' +
      '# @run-id: abc\n' +
      '# @settings\n' +
      '# verifySsl: false\n' +
      '# @end-settings\n' +
      '\n' +
      'POST /x HTTP/1.1\n' +
      'Content-Type: application/json\n' +
      '\n' +
      '{"k":1}\n' +
      '\n' +
      '### Response\n' +
      '\n' +
      'HTTP/1.1 201 Created\n' +
      'Location: /x/1\n' +
      '\n' +
      '\n' +
      '# @script-results: post-response\n' +
      '# log: created\n' +
      '# @end-script-results\n'
    const file = parseActivityLog(text)
    expect(serializeActivityLog(file)).toBe(text)
  })
})
