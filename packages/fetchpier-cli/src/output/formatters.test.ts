import { describe, it, expect } from 'vitest'
import { byteLength, formatDuration, formatSize, redactHeaders } from './formatters'

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
