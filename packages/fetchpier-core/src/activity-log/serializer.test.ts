import { describe, expect, it } from 'vitest'
import { serializeActivityLog } from './serializer'
import type { ActivityLogFile } from './types'

describe('serializeActivityLog', () => {
  it('emits header directives, request, ### Response, response in order', () => {
    const file: ActivityLogFile = {
      header: [
        { kind: 'directive', key: 'timestamp', value: '2026-05-15T14:23:04.123Z' },
        { kind: 'directive', key: 'run-id', value: 'abc-uuid' },
        { kind: 'directive', key: 'duration-ms', value: '184' }
      ],
      requestRaw: 'GET /api/users HTTP/1.1\nHost: example.com\n\n',
      responseRaw: 'HTTP/1.1 200 OK\nContent-Type: application/json\n\n{"ok":true}\n',
      tailBlocks: []
    }
    const out = serializeActivityLog(file)
    expect(out).toBe(
      '# @timestamp: 2026-05-15T14:23:04.123Z\n' +
        '# @run-id: abc-uuid\n' +
        '# @duration-ms: 184\n' +
        '\n' +
        'GET /api/users HTTP/1.1\n' +
        'Host: example.com\n' +
        '\n' +
        '\n' +
        '### Response\n' +
        '\n' +
        'HTTP/1.1 200 OK\n' +
        'Content-Type: application/json\n' +
        '\n' +
        '{"ok":true}\n'
    )
  })

  it('emits header blocks with # prefix on every inner line', () => {
    const file: ActivityLogFile = {
      header: [
        { kind: 'directive', key: 'timestamp', value: '2026-05-15T14:23:04.123Z' },
        {
          kind: 'block',
          name: 'settings',
          lines: ['verifySsl: false', 'followRedirects: true']
        }
      ],
      requestRaw: 'GET / HTTP/1.1\n\n',
      responseRaw: 'HTTP/1.1 200 OK\n\n',
      tailBlocks: []
    }
    const out = serializeActivityLog(file)
    expect(out).toContain('# @settings\n')
    expect(out).toContain('# verifySsl: false\n')
    expect(out).toContain('# followRedirects: true\n')
    expect(out).toContain('# @end-settings\n')
  })

  it('emits tail extension blocks after the response, separated by blanks', () => {
    const file: ActivityLogFile = {
      header: [{ kind: 'directive', key: 'timestamp', value: 't' }],
      requestRaw: 'GET / HTTP/1.1\n\n',
      responseRaw: 'HTTP/1.1 200 OK\n\n',
      tailBlocks: [
        {
          name: 'script-results: post-response',
          lines: ['log: hello', 'pass: status is 200']
        }
      ]
    }
    const out = serializeActivityLog(file)
    expect(out).toContain('HTTP/1.1 200 OK\n')
    expect(out).toMatch(
      /\n\n# @script-results: post-response\n# log: hello\n# pass: status is 200\n# @end-script-results\n$/
    )
  })

  it('preserves free-form comments and blank items in the header', () => {
    const file: ActivityLogFile = {
      header: [
        { kind: 'comment', text: '# free-form note' },
        { kind: 'blank' },
        { kind: 'directive', key: 'timestamp', value: 't' }
      ],
      requestRaw: 'GET / HTTP/1.1\n\n',
      responseRaw: 'HTTP/1.1 200 OK\n\n',
      tailBlocks: []
    }
    const out = serializeActivityLog(file)
    expect(out.startsWith('# free-form note\n\n# @timestamp: t\n\n')).toBe(true)
  })

  it('normalizes trailing newlines on raw sections (no double-blank)', () => {
    const withTrailing: ActivityLogFile = {
      header: [{ kind: 'directive', key: 't', value: '1' }],
      requestRaw: 'GET / HTTP/1.1\n\nbody\n', // trailing newline present
      responseRaw: 'HTTP/1.1 200 OK\n\nx\n',
      tailBlocks: []
    }
    const withoutTrailing: ActivityLogFile = {
      ...withTrailing,
      requestRaw: 'GET / HTTP/1.1\n\nbody', // no trailing
      responseRaw: 'HTTP/1.1 200 OK\n\nx'
    }
    expect(serializeActivityLog(withTrailing)).toBe(serializeActivityLog(withoutTrailing))
  })
})
