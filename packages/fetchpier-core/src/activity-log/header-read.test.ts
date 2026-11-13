import { describe, expect, it } from 'vitest'
import { readMetadataPreview } from './header-read'

describe('readMetadataPreview', () => {
  it('extracts directives, request method/URL and response status from a canonical file', () => {
    const text =
      '# @timestamp: 2026-05-15T14:23:04.123Z\n' +
      '# @run-id: abc\n' +
      '# @request-id: r1\n' +
      '# @source-file: requests/auth/login.http\n' +
      '# @duration-ms: 184\n' +
      '\n' +
      'POST /api/auth/login HTTP/1.1\n' +
      'Host: example.com\n' +
      'Content-Type: application/json\n' +
      '\n' +
      '{"u":"x"}\n' +
      '\n' +
      '### Response\n' +
      '\n' +
      'HTTP/1.1 200 OK\n' +
      'Content-Type: application/json\n' +
      '\n' +
      '{"token":"ey"}\n'
    const p = readMetadataPreview(text)
    expect(p.directives['timestamp']).toBe('2026-05-15T14:23:04.123Z')
    expect(p.directives['run-id']).toBe('abc')
    expect(p.directives['source-file']).toBe('requests/auth/login.http')
    expect(p.directives['duration-ms']).toBe('184')
    expect(p.requestLine).toEqual({ method: 'POST', url: '/api/auth/login' })
    expect(p.responseStatus).toEqual({ code: 200, statusText: 'OK' })
  })

  it('reads a method with a hyphen or a digit, the .http parser grammar (HIS-16)', () => {
    const run = (requestLine: string): string =>
      `# @run-id: r\n\n${requestLine}\n\n### Response\n\nHTTP/1.1 200 OK\n`
    expect(readMetadataPreview(run('VERSION-CONTROL /x HTTP/1.1')).requestLine).toEqual({
      method: 'VERSION-CONTROL',
      url: '/x'
    })
    expect(readMetadataPreview(run('m2 /x HTTP/1.1')).requestLine).toEqual({
      method: 'M2',
      url: '/x'
    })
    // Outside the grammar (leading digit, or a character the parser rejects).
    expect(readMetadataPreview(run('2M /x HTTP/1.1')).requestLine).toBeNull()
    expect(readMetadataPreview(run('GE_T /x HTTP/1.1')).requestLine).toBeNull()
  })

  it('captures header blocks (e.g. @settings)', () => {
    const text =
      '# @timestamp: t\n' +
      '# @settings\n' +
      '# verifySsl: false\n' +
      '# httpVersion: auto\n' +
      '# @end-settings\n' +
      '\n' +
      'GET / HTTP/1.1\n' +
      '\n' +
      '### Response\n' +
      '\n' +
      'HTTP/1.1 204 No Content\n'
    const p = readMetadataPreview(text)
    expect(p.blocks).toEqual([
      {
        name: 'settings',
        lines: ['verifySsl: false', 'httpVersion: auto']
      }
    ])
    expect(p.responseStatus).toEqual({ code: 204, statusText: 'No Content' })
  })

  it('handles a status line without a reason phrase', () => {
    const text =
      '# @timestamp: t\n\nGET / HTTP/1.1\n\n### Response\n\nHTTP/1.1 599\nDate: now\n\nbody\n'
    const p = readMetadataPreview(text)
    expect(p.responseStatus).toEqual({ code: 599, statusText: '' })
  })

  it('returns nulls when request/response lines are missing or malformed', () => {
    const empty =
      '# @timestamp: t\n\nnot a request line\n\n### Response\n\nalso not a status line\n'
    const p = readMetadataPreview(empty)
    expect(p.requestLine).toBe(null)
    expect(p.responseStatus).toBe(null)
  })

  it('returns nulls when the response separator is absent (truncated/corrupt file)', () => {
    const truncated = '# @timestamp: t\n\nGET / HTTP/1.1\nHost: x\n'
    const p = readMetadataPreview(truncated)
    expect(p.requestLine).toEqual({ method: 'GET', url: '/' })
    expect(p.responseStatus).toBe(null)
  })

  it('does not read past the status line — body remains opaque', () => {
    // A `# @<x>` line in the body must not be interpreted.
    const text =
      '# @timestamp: t\n' +
      '\n' +
      'GET / HTTP/1.1\n' +
      '\n' +
      '### Response\n' +
      '\n' +
      'HTTP/1.1 200 OK\n' +
      'Content-Type: text/plain\n' +
      '\n' +
      '# @route-id: should-not-leak\n'
    const p = readMetadataPreview(text)
    expect(p.directives).not.toHaveProperty('route-id')
  })
})
