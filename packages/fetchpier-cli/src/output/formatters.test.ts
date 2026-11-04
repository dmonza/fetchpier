import { describe, it, expect } from 'vitest'
import {
  BODY_DISPLAY_LIMIT_BYTES,
  byteLength,
  formatDuration,
  formatSize,
  redactHeaders,
  redactUrl,
  truncateBody
} from './formatters'

describe('formatDuration', () => {
  it('renders sub-second as ms', () => {
    expect(formatDuration(142)).toBe('142ms')
    expect(formatDuration(0)).toBe('0ms')
  })
  it('renders seconds with two decimals', () => {
    expect(formatDuration(1500)).toBe('1.50s')
  })
  it('renders minutes and seconds', () => {
    expect(formatDuration(123_000)).toBe('2m 3s')
  })
})

describe('formatSize', () => {
  it('renders bytes', () => {
    expect(formatSize(0)).toBe('0B')
    expect(formatSize(387)).toBe('387B')
  })
  it('renders KB and MB, trimming trailing .0', () => {
    expect(formatSize(1024)).toBe('1KB')
    expect(formatSize(1536)).toBe('1.5KB')
    expect(formatSize(1024 * 1024)).toBe('1MB')
  })
})

describe('redactHeaders', () => {
  it('masks the credential but keeps the scheme', () => {
    expect(redactHeaders({ Authorization: 'Bearer abc123' })).toEqual({
      Authorization: 'Bearer [REDACTED]'
    })
  })
  it('masks a schemeless secret entirely', () => {
    expect(redactHeaders({ Authorization: 'abc123' })).toEqual({ Authorization: '[REDACTED]' })
  })
  it('passes secrets through with showSecrets', () => {
    expect(redactHeaders({ Authorization: 'Bearer abc' }, true)).toEqual({
      Authorization: 'Bearer abc'
    })
  })
  it('leaves non-secret headers untouched', () => {
    expect(redactHeaders({ 'Content-Type': 'application/json' })).toEqual({
      'Content-Type': 'application/json'
    })
  })
})

describe('byteLength', () => {
  it('counts UTF-8 bytes', () => {
    expect(byteLength('abc')).toBe(3)
    expect(byteLength('é')).toBe(2)
  })
})

describe('redactHeaders — cookies and the API-key credential (CLI readiness)', () => {
  it('keeps cookie names and redacts their values', () => {
    expect(redactHeaders({ Cookie: 'session=abc123; theme=dark' })).toEqual({
      Cookie: 'session=[REDACTED]; theme=[REDACTED]'
    })
  })

  it('redacts each Set-Cookie value, keeping attributes — an Expires comma is not a cookie boundary', () => {
    const joined =
      'session=abc; Path=/; HttpOnly, pref=x; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Secure'
    expect(redactHeaders({ 'set-cookie': joined })).toEqual({
      'set-cookie':
        'session=[REDACTED]; Path=/; HttpOnly, pref=[REDACTED]; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Secure'
    })
  })

  it('redacts the header the API-key auth scheme materialized, by its configured name', () => {
    expect(
      redactHeaders({ 'x-api-key': 'AK-1', 'X-Other': 'v' }, false, {
        location: 'header',
        name: 'X-API-Key'
      })
    ).toEqual({ 'x-api-key': '[REDACTED]', 'X-Other': 'v' })
  })

  it('passes cookies and the credential through with showSecrets', () => {
    expect(
      redactHeaders({ Cookie: 'a=1', 'X-API-Key': 'k' }, true, {
        location: 'header',
        name: 'X-API-Key'
      })
    ).toEqual({ Cookie: 'a=1', 'X-API-Key': 'k' })
  })
})

describe('redactUrl', () => {
  it('redacts the API-key query parameter value, keeping its name', () => {
    expect(
      redactUrl('https://api.test/v1?page=2&api_key=AK-123&x=1', {
        location: 'query',
        name: 'api_key'
      })
    ).toBe('https://api.test/v1?page=2&api_key=[REDACTED]&x=1')
  })

  it('matches the parameter name in its percent-encoded form too', () => {
    expect(redactUrl('https://api.test/?my%20key=v', { location: 'query', name: 'my key' })).toBe(
      'https://api.test/?my%20key=[REDACTED]'
    )
  })

  it('leaves the URL alone for a header credential, no credential, or showSecrets', () => {
    const url = 'https://api.test/?api_key=v'
    expect(redactUrl(url, { location: 'header', name: 'api_key' })).toBe(url)
    expect(redactUrl(url, undefined)).toBe(url)
    expect(redactUrl(url, { location: 'query', name: 'api_key' }, true)).toBe(url)
  })

  it('does not touch a parameter whose name merely contains the key', () => {
    const url = 'https://api.test/?my_api_key=v'
    expect(redactUrl(url, { location: 'query', name: 'api_key' })).toBe(url)
  })
})

describe('truncateBody', () => {
  it('returns a body at or under the limit unchanged', () => {
    expect(truncateBody('abc', 3)).toEqual({ text: 'abc', truncated: false, totalBytes: 3 })
  })

  it('cuts a body over the limit and reports its total size', () => {
    const out = truncateBody('x'.repeat(10), 4)
    expect(out).toEqual({ text: 'xxxx', truncated: true, totalBytes: 10 })
  })

  it('defaults to 64 KB', () => {
    expect(BODY_DISPLAY_LIMIT_BYTES).toBe(64 * 1024)
  })
})
