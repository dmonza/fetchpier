import { describe, expect, it, vi } from 'vitest'
import { parseHttpFile } from './parser'
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
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
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
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
