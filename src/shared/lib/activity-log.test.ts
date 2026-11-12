// Exercises the renderer-safe wrapper end-to-end: raw `.http` text → parsed
// `ActivityLogFile` → reconstructed `HistoryEntry`. The wrapper's converter
// logic mirrors `packages/fetchpier-core/src/workspace/history-format.ts`'s
// reverse direction; the duplication is intentional (the renderer can't
// reach into `workspace/` because of Node imports) and these tests keep both
// copies in sync.

import { describe, expect, it } from 'vitest'
import {
  activityLogToHistoryEntry,
  historyEntryFromRaw,
  parseActivityLog,
  parseScriptResultEntries
} from './activity-log'

const RAW =
  '# @timestamp: 2026-05-15T14:23:04.123Z\n' +
  '# @run-id: 0c0e1234-1111-2222-3333-444455556666\n' +
  '# @request-id: 9e3a5678-aaaa-bbbb-cccc-ddddeeeeffff\n' +
  '# @source-file: requests/auth/login.http\n' +
  '# @duration-ms: 184\n' +
  '# @path-raw: https://api.example.com/auth/login\n' +
  '# @remote-ip: 203.0.113.42\n' +
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
  'POST https://api.example.com/auth/login HTTP/1.1\n' +
  'Content-Type: application/json\n' +
  'Cookie: sid=abc123\n' +
  '\n' +
  '{"user":"juan"}\n' +
  '\n' +
  '### Response\n' +
  '\n' +
  'HTTP/1.1 200 OK\n' +
  'Content-Type: application/json\n' +
  'Set-Cookie: refresh=def456; Path=/; HttpOnly\n' +
  '\n' +
  '{"token":"ey"}\n' +
  '\n' +
  '# @script-results: post-response\n' +
  '# log: token = "ey"\n' +
  '# pass: response is JSON\n' +
  '# fail: status is 201 — expected 201, got 200\n' +
  '# @end-script-results\n'

describe('shared/lib/activity-log', () => {
  it('parseActivityLog round-trips the canonical fixture', () => {
    const file = parseActivityLog(RAW)
    expect(file.header.length).toBeGreaterThan(0)
    expect(file.tailBlocks.length).toBe(1)
  })

  it('activityLogToHistoryEntry recovers run-id, request-id, source-file, remote-ip', () => {
    const entry = activityLogToHistoryEntry(parseActivityLog(RAW))
    expect(entry.id).toBe('0c0e1234-1111-2222-3333-444455556666')
    expect(entry.requestId).toBe('9e3a5678-aaaa-bbbb-cccc-ddddeeeeffff')
    expect(entry.sourceFile).toBe('requests/auth/login.http')
    expect(entry.remoteIp).toBe('203.0.113.42')
    expect(entry.timestamp).toBe('2026-05-15T14:23:04.123Z')
  })

  it('recovers method, URL, headers and body from the request raw', () => {
    const entry = activityLogToHistoryEntry(parseActivityLog(RAW))
    expect(entry.request.method).toBe('POST')
    expect(entry.request.url).toBe('https://api.example.com/auth/login')
    expect(entry.request.headers['Content-Type']).toBe('application/json')
    expect(entry.request.headers['Cookie']).toBe('sid=abc123')
    expect(entry.request.body).toBe('{"user":"juan"}')
  })

  it('recovers status, status text, headers and body from the response raw', () => {
    const entry = activityLogToHistoryEntry(parseActivityLog(RAW))
    expect(entry.response.status).toBe(200)
    expect(entry.response.statusText).toBe('OK')
    expect(entry.response.headers['Content-Type']).toBe('application/json')
    expect(entry.response.headers['Set-Cookie']).toBe('refresh=def456; Path=/; HttpOnly')
    expect(entry.response.body).toBe('{"token":"ey"}')
    expect(entry.response.timingMs).toBe(184)
  })

  it('parses the @settings block into resolvedSettings', () => {
    const entry = activityLogToHistoryEntry(parseActivityLog(RAW))
    expect(entry.resolvedSettings).toBeDefined()
    expect(entry.resolvedSettings!.verifySsl).toBe(false)
    expect(entry.resolvedSettings!.followRedirects).toBe(true)
    expect(entry.resolvedSettings!.maxRedirects).toBe(5)
    expect(entry.resolvedSettings!.httpVersion).toBe('auto')
  })

  it('parses the script-results tail block into ScriptResultsBundle', () => {
    const entry = activityLogToHistoryEntry(parseActivityLog(RAW))
    expect(entry.scriptResults?.postResponse).toBeDefined()
    const post = entry.scriptResults!.postResponse!
    expect(post.success).toBe(false)
    expect(post.logs.length).toBe(1)
    expect(post.logs[0]!.level).toBe('log')
    expect(post.testResults.length).toBe(2)
    expect(post.testResults[0]).toEqual({ name: 'response is JSON', passed: true })
    expect(post.testResults[1]).toEqual({
      name: 'status is 201',
      passed: false,
      error: 'expected 201, got 200'
    })
  })

  it('historyEntryFromRaw is parse + rebuild in one call', () => {
    const fromConvenience = historyEntryFromRaw(RAW)
    const fromTwoSteps = activityLogToHistoryEntry(parseActivityLog(RAW))
    expect(fromConvenience).toEqual(fromTwoSteps)
  })

  // HIS-18: the rebuilt size is a byte count — the placeholder's recorded
  // count for a binary body, else the body's UTF-8 length.
  describe('rebuilt response sizeBytes', () => {
    const withResponseBody = (body: string) =>
      historyEntryFromRaw(
        '# @timestamp: t\n\nGET / HTTP/1.1\n\n### Response\n\nHTTP/1.1 200 OK\n\n' + body + '\n'
      )

    it('takes the count from a binary placeholder', () => {
      const entry = withResponseBody('[binary body, 2097152 bytes, content-type: image/png]')
      expect(entry.response.sizeBytes).toBe(2097152)
    })

    it('takes the count from a placeholder that names a content-encoding', () => {
      const entry = withResponseBody(
        '[binary body, 512 bytes, content-type: application/json, content-encoding: br]'
      )
      expect(entry.response.sizeBytes).toBe(512)
    })

    it('measures a non-ASCII text body in UTF-8 bytes', () => {
      const body = '{"name":"José Ñandú 日本"}'
      expect(withResponseBody(body).response.sizeBytes).toBe(31)
    })

    it('measures a text body that only quotes the placeholder as text', () => {
      const body = 'see [binary body, 10 bytes, content-type: image/png]'
      expect(withResponseBody(body).response.sizeBytes).toBe(body.length)
    })

    it('is zero for an empty body', () => {
      expect(withResponseBody('').response.sizeBytes).toBe(0)
    })
  })

  it('rebuilds top-level script error message + filtered stack from the block', () => {
    const withError =
      '# @timestamp: t\n' +
      '\n' +
      'GET / HTTP/1.1\n' +
      '\n' +
      '### Response\n' +
      '\n' +
      'HTTP/1.1 500 Internal Server Error\n' +
      '\n' +
      '# @script-results: post-response\n' +
      '# error: x is not a function\n' +
      '# stack: <post-response>:3:5\n' +
      '# stack: <post-response>:7:12\n' +
      '# @end-script-results\n'
    const entry = historyEntryFromRaw(withError)
    const post = entry.scriptResults!.postResponse!
    expect(post.success).toBe(false)
    expect(post.error?.message).toBe('x is not a function')
    expect(post.error?.stack).toContain('<post-response>:3:5')
    expect(post.error?.stack).toContain('<post-response>:7:12')
  })

  it('handles entries with no settings block and no script results', () => {
    const minimal =
      '# @timestamp: 2026-05-15T14:23:04.123Z\n' +
      '# @run-id: abc\n' +
      '# @duration-ms: 50\n' +
      '# @path-raw: /\n' +
      '\n' +
      'GET / HTTP/1.1\n' +
      '\n' +
      '### Response\n' +
      '\n' +
      'HTTP/1.1 204 No Content\n'
    const entry = historyEntryFromRaw(minimal)
    expect(entry.resolvedSettings).toBeUndefined()
    expect(entry.scriptResults).toBeUndefined()
    expect(entry.response.status).toBe(204)
    expect(entry.request.body).toBeUndefined()
  })

  describe('parseScriptResultEntries (REQ-0069)', () => {
    it('preserves source order when logs and tests interleave', () => {
      const lines = [
        'log: starting',
        'pass: t1',
        'warn: heads up',
        'fail: t2 — expected 1 got 2',
        'log: done'
      ]
      const entries = parseScriptResultEntries(lines)
      expect(entries).toEqual([
        { kind: 'log', level: 'log', text: 'starting' },
        { kind: 'test', name: 't1', passed: true },
        { kind: 'log', level: 'warn', text: 'heads up' },
        { kind: 'test', name: 't2', passed: false, message: 'expected 1 got 2' },
        { kind: 'log', level: 'log', text: 'done' }
      ])
    })

    it('attaches stack frames to the preceding error entry', () => {
      const entries = parseScriptResultEntries([
        'log: before',
        'error: x is not a function',
        'stack: <post-response>:3:5',
        'stack: <post-response>:7:12',
        'log: after'
      ])
      expect(entries).toHaveLength(3)
      expect(entries[0]).toEqual({ kind: 'log', level: 'log', text: 'before' })
      const err = entries[1]!
      expect(err.kind).toBe('error')
      if (err.kind === 'error') {
        expect(err.message).toBe('x is not a function')
        expect(err.stack).toContain('<post-response>:3:5')
        expect(err.stack).toContain('<post-response>:7:12')
      }
      expect(entries[2]).toEqual({ kind: 'log', level: 'log', text: 'after' })
    })

    it('falls back to log when the tag is unknown', () => {
      expect(parseScriptResultEntries(['debug: hi'])).toEqual([
        { kind: 'log', level: 'log', text: '[debug] hi' }
      ])
    })

    it('returns [] for empty input and ignores lines without colon', () => {
      expect(parseScriptResultEntries([])).toEqual([])
      expect(parseScriptResultEntries(['noop'])).toEqual([])
    })

    it('handles a failing test without a message separator', () => {
      expect(parseScriptResultEntries(['fail: orphan'])).toEqual([
        { kind: 'test', name: 'orphan', passed: false }
      ])
    })
  })

  it('parses unknown log levels (e.g. debug:) into log entries with a prefix tag', () => {
    const withDebug =
      '# @timestamp: t\n\nGET / HTTP/1.1\n\n### Response\n\nHTTP/1.1 200 OK\n\n' +
      '# @script-results: pre-request\n' +
      '# debug: some diagnostic\n' +
      '# info: extra info\n' +
      '# @end-script-results\n'
    const entry = historyEntryFromRaw(withDebug)
    const pre = entry.scriptResults!.preRequest!
    expect(pre.logs.length).toBe(2)
    expect(pre.logs[0]!.args[0]).toContain('debug')
    expect(pre.logs[1]!.args[0]).toContain('info')
  })
})
