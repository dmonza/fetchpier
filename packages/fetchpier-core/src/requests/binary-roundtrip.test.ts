import { describe, expect, it, vi } from 'vitest'
import { parseHttpFile } from './parser'
import { sanitizeOriginalName } from './binary-store'
import { serializeRequest } from '@shared/lib/http-serializer'
import { DEFAULT_REQUEST_STATE } from '@shared/types'
import type { RequestEditorState } from '@shared/types'

const VALID_HASH = 'a'.repeat(64)
const VALID_REF = `${VALID_HASH}__report.pdf`

function state(overrides: Partial<RequestEditorState> = {}): RequestEditorState {
  return { ...DEFAULT_REQUEST_STATE, ...overrides }
}

describe('binary body — parser ↔ serializer round-trip', () => {
  it('parses # @binary-file: into a populated binaryFile and bodyType', () => {
    const text = `# @id 12345678-1234-1234-1234-123456789012
POST https://example.com/upload
X-Tag: one

# @binary-file: ${VALID_REF}
`
    const parsed = parseHttpFile(text)
    expect(parsed.requestId).toBe('12345678-1234-1234-1234-123456789012')
    expect(parsed.requests).toHaveLength(1)
    const req = parsed.requests[0]
    expect(req.bodyType).toBe('binary')
    expect(req.binaryFile?.ref).toBe(VALID_REF)
    expect(req.binaryFile?.originalName).toBe('report.pdf')
    expect(req.binaryFile?.mimeType).toBe('application/pdf')
    expect(req.body).toBeUndefined()
  })

  it('survives a full serialize → parse round-trip', () => {
    const originalState = state({
      method: 'POST',
      url: 'https://example.com/upload',
      headers: [{ id: 'h1', key: 'X-Tag', value: 'one', enabled: true }],
      bodyType: 'binary',
      binaryFile: {
        ref: VALID_REF,
        originalName: 'report.pdf',
        sizeBytes: 1234,
        mimeType: 'application/pdf'
      }
    })
    const text = serializeRequest(originalState, '12345678-1234-1234-1234-123456789012')
    const parsed = parseHttpFile(text)
    expect(parsed.requests).toHaveLength(1)
    expect(parsed.requests[0].bodyType).toBe('binary')
    expect(parsed.requests[0].binaryFile?.ref).toBe(VALID_REF)
    expect(parsed.requests[0].binaryFile?.originalName).toBe('report.pdf')
    expect(parsed.requests[0].body).toBeUndefined()
  })

  it('warns and ignores an invalid binary ref', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const text = `POST https://example.com/x

# @binary-file: not-a-valid-ref
`
    const parsed = parseHttpFile(text)
    expect(parsed.requests[0].binaryFile).toBeUndefined()
    expect(parsed.requests[0].bodyType).toBeUndefined()
    expect(parsed.warnings?.[0]).toContain('invalid # @binary-file')
    // Carried on the request so the engine refuses to send it bodiless.
    expect(parsed.requests[0].invalidBinaryRef).toBe('not-a-valid-ref')
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  // A save must not delete the reference the author wrote: the editor keeps it
  // (binary mode, no file — the state `request-loader` builds) and the
  // serializer re-emits it, so the file is byte-identical after a save.
  it('an invalid reference survives a save byte-identical', () => {
    const text =
      '# @id 9e3a4f72-1234-4abc-9def-0123456789ab\n# @binary-file: not-a-valid-ref\nPOST https://example.com/x\n'
    const parsed = parseHttpFile(text)
    const r = parsed.requests[0]
    const state: RequestEditorState = {
      ...DEFAULT_REQUEST_STATE,
      method: r.method,
      url: r.url,
      bodyType: 'binary',
      invalidBinaryRef: r.invalidBinaryRef
    }
    expect(serializeRequest(state, parsed.requestId)).toBe(text)
  })

  describe('a ref whose staged name has spaces (FMT-05)', () => {
    const name = sanitizeOriginalName('My Report 2026.pdf')
    const spacedRef = `${VALID_HASH}__${name}`

    it('survives serialize → parse and a second save byte-identical', () => {
      const original = state({
        method: 'POST',
        url: 'https://example.com/upload',
        bodyType: 'binary',
        binaryFile: {
          ref: spacedRef,
          originalName: name,
          sizeBytes: 0,
          mimeType: 'application/pdf'
        }
      })
      const text = serializeRequest(original)
      const parsed = parseHttpFile(text)
      const r = parsed.requests[0]
      expect(parsed.warnings).toBeUndefined()
      expect(r.bodyType).toBe('binary')
      expect(r.binaryFile?.ref).toBe(spacedRef)
      expect(r.binaryFile?.originalName).toBe('My Report 2026.pdf')
      expect(r.binaryFile?.mimeType).toBe('application/pdf')
      expect(r.comments).toBeUndefined()
      expect(serializeRequest(state({ ...original, binaryFile: r.binaryFile }))).toBe(text)
    })

    it('is read by the legacy first-body-line shim too', () => {
      const text = `POST https://example.com/upload\n\n# @binary-file: ${spacedRef}\n`
      const r = parseHttpFile(text).requests[0]
      expect(r.bodyType).toBe('binary')
      expect(r.binaryFile?.ref).toBe(spacedRef)
      expect(r.body).toBeUndefined()
    })

    it('drops trailing whitespace after the ref', () => {
      const text = `# @binary-file: ${spacedRef}  \t\nPOST https://example.com/upload\n`
      expect(parseHttpFile(text).requests[0].binaryFile?.ref).toBe(spacedRef)
    })

    it('a malformed value with spaces is still an invalid ref, kept by a save', () => {
      const text = '# @binary-file: not a valid ref\nPOST https://example.com/x\n'
      const parsed = parseHttpFile(text)
      const r = parsed.requests[0]
      expect(r.binaryFile).toBeUndefined()
      expect(r.invalidBinaryRef).toBe('not a valid ref')
      expect(parsed.warnings?.[0]).toContain('invalid # @binary-file')
      const saved = serializeRequest(
        state({
          method: r.method,
          url: r.url,
          bodyType: 'binary',
          invalidBinaryRef: r.invalidBinaryRef
        })
      )
      expect(saved).toBe(text)
    })
  })

  it('warns and prefers the binary ref when a body coexists with the marker', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const text = `POST https://example.com/x

# @binary-file: ${VALID_REF}
this body should be discarded
`
    const parsed = parseHttpFile(text)
    expect(parsed.requests[0].binaryFile?.ref).toBe(VALID_REF)
    expect(parsed.requests[0].body).toBeUndefined()
    expect(parsed.warnings?.[0]).toContain('body is discarded')
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
