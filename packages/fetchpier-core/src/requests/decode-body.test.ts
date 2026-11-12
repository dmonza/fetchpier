import { describe, expect, it } from 'vitest'
import { brotliCompressSync, deflateRawSync, deflateSync, gzipSync } from 'node:zlib'
import { decodeBody, MAX_DECODED_BYTES } from './decode-body'

const TEXT = '{"hello":"world","items":[1,2,3,4,5,6,7,8,9,10]}'.repeat(20)
const RAW = Buffer.from(TEXT, 'utf-8')

describe('decodeBody', () => {
  it.each([
    ['gzip', gzipSync(RAW)],
    ['x-gzip', gzipSync(RAW)],
    ['deflate', deflateSync(RAW)],
    ['br', brotliCompressSync(RAW)]
  ])('decodes %s', (encoding, wire) => {
    const out = decodeBody(wire, encoding)
    expect(out.status).toBe('decoded')
    expect(out.body.toString('utf-8')).toBe(TEXT)
    expect(out.compressedBytes).toBe(wire.length)
    expect(out.decompressedBytes).toBe(RAW.length)
    expect(out.warning).toBeUndefined()
  })

  it('decodes raw deflate (no zlib wrapper), which some servers send', () => {
    const out = decodeBody(deflateRawSync(RAW), 'deflate')
    expect(out.status).toBe('decoded')
    expect(out.body.toString('utf-8')).toBe(TEXT)
  })

  it('is case- and whitespace-insensitive', () => {
    expect(decodeBody(gzipSync(RAW), '  GZip ').status).toBe('decoded')
  })

  it('decodes stacked codings in reverse order of application', () => {
    // Applied gzip first, then br → header lists "gzip, br".
    const wire = brotliCompressSync(gzipSync(RAW))
    const out = decodeBody(wire, 'gzip, br')
    expect(out.status).toBe('decoded')
    expect(out.body.toString('utf-8')).toBe(TEXT)
  })

  it.each([undefined, '', 'identity'])('no coding (%s) is not-required', (encoding) => {
    const out = decodeBody(RAW, encoding)
    expect(out.status).toBe('not-required')
    expect(out.body).toBe(RAW)
    expect(out.compressedBytes).toBe(RAW.length)
    expect(out.decompressedBytes).toBe(RAW.length)
  })

  it('an empty body is not-required even with a declared coding', () => {
    const out = decodeBody(Buffer.alloc(0), 'gzip')
    expect(out.status).toBe('not-required')
    expect(out.warning).toBeUndefined()
  })

  it('an unsupported coding keeps the body as received and warns', () => {
    const out = decodeBody(RAW, 'zstd')
    expect(out.status).toBe('unsupported')
    expect(out.body).toBe(RAW)
    expect(out.decompressedBytes).toBe(RAW.length)
    expect(out.warning).toEqual({ code: 'UNSUPPORTED_CONTENT_ENCODING', encoding: 'zstd' })
  })

  it('an unsupported coding anywhere in a stack makes the whole body unsupported', () => {
    expect(decodeBody(gzipSync(RAW), 'compress, gzip').status).toBe('unsupported')
  })

  it('a corrupt body keeps the bytes as received and warns with the reason', () => {
    const corrupt = gzipSync(RAW).subarray(0, 20)
    const out = decodeBody(corrupt, 'gzip')
    expect(out.status).toBe('failed')
    expect(out.body).toBe(corrupt)
    expect(out.warning?.code).toBe('RESPONSE_DECODING_FAILED')
    expect(out.warning && 'reason' in out.warning && out.warning.reason).toBeTruthy()
  })

  it('a body that would decode past the cap fails instead of exhausting memory', () => {
    const bomb = gzipSync(Buffer.alloc(64 * 1024, 0))
    const out = decodeBody(bomb, 'gzip', { maxDecodedBytes: 1024 })
    expect(out.status).toBe('failed')
    expect(out.body).toBe(bomb)
  })

  // ENG-16: the raw-inflate fallback must not mask the cap error.
  it.each([
    ['zlib-wrapped', deflateSync],
    ['raw', deflateRawSync]
  ])('a %s deflate body past the cap reports the size limit', (_l, compress) => {
    const bomb = compress(Buffer.alloc(64 * 1024, 0))
    const out = decodeBody(bomb, 'deflate', { maxDecodedBytes: 1024 })
    expect(out.status).toBe('failed')
    expect(out.body).toBe(bomb)
    expect(out.warning && 'reason' in out.warning && out.warning.reason).toMatch(/larger than 1024/)
  })

  it('exposes a generous default cap', () => {
    expect(MAX_DECODED_BYTES).toBe(100 * 1024 * 1024)
  })
})
