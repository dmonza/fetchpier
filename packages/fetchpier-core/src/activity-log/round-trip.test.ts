// Property-style round-trip tests: serialize(parse(x)) === x for canonical
// fixtures (REQ-0068 §6.4 + CA-02 / CA-08).
//
// Each fixture is hand-written in the canonical layout the serializer emits
// (one blank line per section separator, LF line endings, `# @end-<head>`
// markers). The point is to lock down the byte-level format and prove that
// unknown directives and unknown blocks — i.e. extensions from other domains
// or future directives — survive a round-trip unchanged.

import { describe, expect, it } from 'vitest'
import { parseActivityLog } from './parser'
import { serializeActivityLog } from './serializer'

function roundTrip(text: string): string {
  return serializeActivityLog(parseActivityLog(text))
}

describe('round-trip serialize(parse(x)) === x', () => {
  it('minimal canonical file', () => {
    const text =
      '# @timestamp: 2026-05-15T14:23:04.123Z\n' +
      '\n' +
      'GET / HTTP/1.1\n' +
      '\n' +
      '### Response\n' +
      '\n' +
      'HTTP/1.1 200 OK\n'
    expect(roundTrip(text)).toBe(text)
  })

  it('with header @settings block + multiple directives', () => {
    const text =
      '# @timestamp: 2026-05-15T14:23:04.123Z\n' +
      '# @run-id: 0c0e-1111-2222-3333\n' +
      '# @request-id: 9e3a-aaaa-bbbb-cccc\n' +
      '# @source-file: requests/auth/login.http\n' +
      '# @duration-ms: 184\n' +
      '# @path-raw: https://api.example.com/auth/login?ttl=30\n' +
      '# @remote-ip: 203.0.113.42\n' +
      '# @script-pre: ok\n' +
      '# @script-post: failed (1 passed, 1 failed)\n' +
      '# @settings\n' +
      '# verifySsl: false\n' +
      '# followRedirects: true\n' +
      '# maxRedirects: 5\n' +
      '# followAuthorizationOnRedirect: false\n' +
      '# encodeUrl: true\n' +
      '# disableCookieJar: false\n' +
      '# httpVersion: auto\n' +
      '# @end-settings\n' +
      '\n' +
      'POST /auth/login HTTP/1.1\n' +
      'Host: api.example.com\n' +
      'Content-Type: application/json\n' +
      'Cookie: session=abc123\n' +
      '\n' +
      '{"user":"x","pass":"y"}\n' +
      '\n' +
      '### Response\n' +
      '\n' +
      'HTTP/1.1 200 OK\n' +
      'Content-Type: application/json\n' +
      'Set-Cookie: refresh=def456; Path=/; HttpOnly\n' +
      '\n' +
      '{"token":"ey..."}\n' +
      '\n' +
      '# @script-results: post-response\n' +
      '# log: token = "ey..."\n' +
      '# pass: response is JSON\n' +
      '# fail: status is 201 — expected 201, got 200\n' +
      '# @end-script-results\n'
    expect(roundTrip(text)).toBe(text)
  })

  it('preserves unknown directives (extension-tolerant — REQ §6.4)', () => {
    // Simulate a mock-domain extension that the requests-side parser must not
    // strip. `# @route-id`, `# @matched`, `# @origin-ip` are not interpreted
    // here but must survive the round-trip untouched.
    const text =
      '# @timestamp: 2026-05-15T14:23:04.123Z\n' +
      '# @route-id: routes/users/list.yaml\n' +
      '# @origin-ip: 198.51.100.7\n' +
      '# @matched\n' +
      '# pattern: GET /users\n' +
      '# rank: 1\n' +
      '# @end-matched\n' +
      '\n' +
      'GET /users HTTP/1.1\n' +
      '\n' +
      '### Response\n' +
      '\n' +
      'HTTP/1.1 200 OK\n' +
      'Content-Type: application/json\n' +
      '\n' +
      '[]\n'
    expect(roundTrip(text)).toBe(text)
  })

  it('preserves a free-form comment + blank line + unknown directive in header order', () => {
    const text =
      '# free-form developer note\n' +
      '\n' +
      '# @timestamp: t\n' +
      '# @future-flag: yes\n' +
      '\n' +
      'GET / HTTP/1.1\n' +
      '\n' +
      '### Response\n' +
      '\n' +
      'HTTP/1.1 200 OK\n'
    expect(roundTrip(text)).toBe(text)
  })

  it('preserves a binary-body placeholder in the response (no body parsing)', () => {
    const text =
      '# @timestamp: t\n' +
      '\n' +
      'GET /file.pdf HTTP/1.1\n' +
      '\n' +
      '### Response\n' +
      '\n' +
      'HTTP/1.1 200 OK\n' +
      'Content-Type: application/pdf\n' +
      '\n' +
      '[binary body, 12345 bytes, content-type: application/pdf]\n'
    expect(roundTrip(text)).toBe(text)
  })

  it('preserves multiple tail blocks', () => {
    const text =
      '# @timestamp: t\n' +
      '\n' +
      'GET / HTTP/1.1\n' +
      '\n' +
      '### Response\n' +
      '\n' +
      'HTTP/1.1 200 OK\n' +
      '\n' +
      '# @script-results: pre-request\n' +
      '# log: pre ran\n' +
      '# @end-script-results\n' +
      '\n' +
      '# @script-results: post-response\n' +
      '# pass: x\n' +
      '# @end-script-results\n'
    expect(roundTrip(text)).toBe(text)
  })
})
