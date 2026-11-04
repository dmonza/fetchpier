import { describe, expect, it } from 'vitest'
import { binaryPlaceholder, bodyByteLength, detectBinaryBody } from './binary'

describe('detectBinaryBody', () => {
  it('flags binary content-types from the closed exact list', () => {
    expect(detectBinaryBody({ contentType: 'application/octet-stream' })).toEqual({
      isBinary: true,
      reason: 'content-type'
    })
    expect(detectBinaryBody({ contentType: 'application/pdf' }).isBinary).toBe(true)
    expect(detectBinaryBody({ contentType: 'application/zip' }).isBinary).toBe(true)
    expect(detectBinaryBody({ contentType: 'application/wasm' }).isBinary).toBe(true)
    expect(detectBinaryBody({ contentType: 'application/x-protobuf' }).isBinary).toBe(true)
  })

  it('flags binary content-types from prefix matches', () => {
    expect(detectBinaryBody({ contentType: 'image/png' }).isBinary).toBe(true)
    expect(detectBinaryBody({ contentType: 'video/mp4' }).isBinary).toBe(true)
    expect(detectBinaryBody({ contentType: 'audio/ogg' }).isBinary).toBe(true)
    expect(detectBinaryBody({ contentType: 'font/woff2' }).isBinary).toBe(true)
  })

  it('strips charset parameters before matching', () => {
    expect(detectBinaryBody({ contentType: 'application/pdf; charset=utf-8' }).isBinary).toBe(true)
    expect(detectBinaryBody({ contentType: 'application/json; charset=utf-8' }).isBinary).toBe(
      false
    )
  })

  it('treats Content-Encoding != identity as binary', () => {
    expect(detectBinaryBody({ contentEncoding: 'gzip' })).toEqual({
      isBinary: true,
      reason: 'content-encoding'
    })
    expect(detectBinaryBody({ contentEncoding: 'br' }).isBinary).toBe(true)
    expect(detectBinaryBody({ contentEncoding: 'identity' }).isBinary).toBe(false)
    expect(detectBinaryBody({ contentEncoding: '' }).isBinary).toBe(false)
  })

  it('falls back to UTF-8 probing for unknown content types', () => {
    const utf8 = '{"hola":"mundo — €"}'
    expect(detectBinaryBody({ body: utf8, contentType: 'application/json' }).isBinary).toBe(false)

    const binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) // PNG magic
    expect(detectBinaryBody({ body: binary }).reason).toBe('utf8-probe')
  })

  it('treats NUL bytes as binary signal even within ASCII range', () => {
    const withNul = new Uint8Array([0x68, 0x69, 0x00, 0x6f, 0x6b])
    expect(detectBinaryBody({ body: withNul }).reason).toBe('utf8-probe')
  })

  it('returns isBinary=false for plain text with no body', () => {
    expect(detectBinaryBody({ contentType: 'text/plain' })).toEqual({ isBinary: false })
    expect(detectBinaryBody({})).toEqual({ isBinary: false })
  })

  it('reads Content-Type / Content-Encoding from headers map case-insensitively', () => {
    const decision = detectBinaryBody({
      headers: { 'Content-Type': 'application/pdf' }
    })
    expect(decision.isBinary).toBe(true)
    const decision2 = detectBinaryBody({
      headers: { 'content-encoding': 'gzip' }
    })
    expect(decision2.isBinary).toBe(true)
  })

  it('a decoded body is judged by its content, not by the kept Content-Encoding header', () => {
    expect(
      detectBinaryBody({
        headers: { 'content-encoding': 'gzip' },
        body: '{"ok":true}',
        decoded: true
      })
    ).toEqual({ isBinary: false })
    // Still binary by content type or by bytes.
    expect(
      detectBinaryBody({ contentType: 'image/png', contentEncoding: 'gzip', decoded: true })
        .isBinary
    ).toBe(true)
    expect(
      detectBinaryBody({
        contentEncoding: 'br',
        body: new Uint8Array([0xff, 0xfe, 0x00]),
        decoded: true
      }).reason
    ).toBe('utf8-probe')
  })

  it('Content-Type wins over Content-Encoding / UTF-8 probe (evaluation order)', () => {
    expect(detectBinaryBody({ contentType: 'application/pdf', body: '"json"' }).reason).toBe(
      'content-type'
    )
  })
})

describe('bodyByteLength', () => {
  it('measures strings as UTF-8 bytes', () => {
    expect(bodyByteLength('hello')).toBe(5)
    expect(bodyByteLength('€')).toBe(3)
    expect(bodyByteLength('')).toBe(0)
    expect(bodyByteLength(null)).toBe(0)
    expect(bodyByteLength(undefined)).toBe(0)
  })

  it('returns byteLength for Uint8Array', () => {
    expect(bodyByteLength(new Uint8Array([1, 2, 3]))).toBe(3)
  })
})

describe('binaryPlaceholder', () => {
  it('formats with content-type and content-encoding', () => {
    expect(
      binaryPlaceholder({ byteLength: 42, contentType: 'image/png', contentEncoding: 'gzip' })
    ).toBe('[binary body, 42 bytes, content-type: image/png, content-encoding: gzip]')
  })

  it('omits content-encoding when missing', () => {
    expect(binaryPlaceholder({ byteLength: 100, contentType: 'application/pdf' })).toBe(
      '[binary body, 100 bytes, content-type: application/pdf]'
    )
  })

  it('falls back to application/octet-stream when content-type is unknown', () => {
    expect(binaryPlaceholder({ byteLength: 5 })).toBe(
      '[binary body, 5 bytes, content-type: application/octet-stream]'
    )
  })
})
