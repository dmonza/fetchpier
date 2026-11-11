import { describe, expect, it } from 'vitest'
import { serializeRequest } from './http-serializer'
import { DEFAULT_REQUEST_STATE } from '../types'
import type { RequestEditorState } from '../types'

const VALID_HASH = 'a'.repeat(64)
const VALID_REF = `${VALID_HASH}__report.pdf`

function state(overrides: Partial<RequestEditorState> = {}): RequestEditorState {
  return { ...DEFAULT_REQUEST_STATE, ...overrides }
}

describe('serializeRequest — binary body marker', () => {
  it('writes `# @binary-file: <ref>` when bodyType=binary and a ref is set', () => {
    const out = serializeRequest(
      state({
        method: 'POST',
        url: 'https://example.com/upload',
        bodyType: 'binary',
        binaryFile: {
          ref: VALID_REF,
          originalName: 'report.pdf',
          sizeBytes: 1234,
          mimeType: 'application/pdf'
        }
      })
    )
    expect(out).toContain(`# @binary-file: ${VALID_REF}`)
    // Body-mode declaration lives in the metadata region, before the request
    // line (D-META: all `# @…` metadata precedes the request line).
    const lines = out.split('\n')
    const markerIdx = lines.findIndex((l) => l.startsWith('# @binary-file:'))
    const reqIdx = lines.findIndex((l) => l.startsWith('POST '))
    expect(markerIdx).toBeGreaterThanOrEqual(0)
    expect(markerIdx).toBeLessThan(reqIdx)
  })

  it('places the binary marker in the metadata region with no body section', () => {
    const out = serializeRequest(
      state({
        method: 'POST',
        url: 'https://example.com/upload',
        bodyType: 'binary',
        binaryFile: {
          ref: VALID_REF,
          originalName: 'report.pdf',
          sizeBytes: 1234,
          mimeType: 'application/pdf'
        }
      })
    )
    // The marker precedes the request line; after it come only the request
    // line and header rows — a binary request carries no body section.
    const lines = out.split('\n')
    const markerIdx = lines.findIndex((l) => l.startsWith('# @binary-file:'))
    const reqIdx = lines.findIndex((l) => l.startsWith('POST '))
    expect(markerIdx).toBeLessThan(reqIdx)
    expect(lines.slice(reqIdx + 1).every((l) => l.trim() === '' || l.includes(':'))).toBe(true)
  })

  it('does NOT write the binary marker when bodyType is not binary', () => {
    const out = serializeRequest(
      state({
        method: 'POST',
        url: 'https://example.com/x',
        bodyType: 'raw',
        body: 'hello'
      })
    )
    expect(out).not.toContain('# @binary-file:')
  })

  it('does NOT write the binary marker when binaryFile is missing', () => {
    const out = serializeRequest(
      state({
        method: 'POST',
        url: 'https://example.com/x',
        bodyType: 'binary'
      })
    )
    expect(out).not.toContain('# @binary-file:')
  })

  // The reference the file held when it was not valid: kept on save until a
  // valid file replaces it, or the user leaves binary mode.
  describe('an invalid reference from the file', () => {
    const file = {
      ref: VALID_REF,
      originalName: 'report.pdf',
      sizeBytes: 1234,
      mimeType: 'application/pdf'
    }

    it('is re-emitted as written while binary mode has no file', () => {
      const out = serializeRequest(
        state({
          method: 'POST',
          url: 'https://x/',
          bodyType: 'binary',
          invalidBinaryRef: 'not-a-ref'
        })
      )
      expect(out).toBe('# @binary-file: not-a-ref\nPOST https://x/\n')
    })

    it('gives way to a valid file once one is attached', () => {
      const out = serializeRequest(
        state({
          method: 'POST',
          url: 'https://x/',
          bodyType: 'binary',
          binaryFile: file,
          invalidBinaryRef: 'not-a-ref'
        })
      )
      expect(out).toContain(`# @binary-file: ${VALID_REF}`)
      expect(out).not.toContain('not-a-ref')
    })

    it('is not written once the body leaves binary mode', () => {
      const out = serializeRequest(
        state({
          method: 'POST',
          url: 'https://x/',
          bodyType: 'raw',
          body: 'hi',
          invalidBinaryRef: 'not-a-ref'
        })
      )
      expect(out).not.toContain('# @binary-file:')
    })
  })
})
