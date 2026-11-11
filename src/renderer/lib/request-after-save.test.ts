import { describe, it, expect } from 'vitest'
import type { MultipartPart, RequestEditorState } from '../../shared/types'
import { DEFAULT_REQUEST_STATE } from '../../shared/types'
import { requestAfterSave } from './request-after-save'

const okPart: MultipartPart = { kind: 'text', id: 'p0', name: 'ok', value: 'v' }
const brokenPart: MultipartPart = {
  kind: 'file',
  id: 'p1',
  name: 'avatar',
  file: { ref: 'bad', originalName: '', sizeBytes: 0, mimeType: 'application/octet-stream' },
  disabled: true,
  parseError: 'MULTIPART_INVALID_PART: invalid file ref "bad"'
}

// The serializer drops what it cannot write back faithfully. The in-memory
// request must match what was written, or the tab stays modified after a save.
describe('requestAfterSave', () => {
  it('drops malformed query parameters and multipart parts carrying a parse error', () => {
    const request: RequestEditorState = {
      ...DEFAULT_REQUEST_STATE,
      bodyType: 'multipart-form',
      params: [
        { id: 'a', key: 'a', value: '%', enabled: true, malformed: true },
        { id: 'b', key: 'b', value: '1', enabled: true }
      ],
      multipartParts: [okPart, brokenPart]
    }
    const saved = requestAfterSave(request)
    expect(saved.params.map((p) => p.key)).toEqual(['b'])
    expect(saved.multipartParts).toEqual([okPart])
  })

  it('returns the request itself when there is nothing to drop', () => {
    const request: RequestEditorState = {
      ...DEFAULT_REQUEST_STATE,
      bodyType: 'multipart-form',
      multipartParts: [okPart]
    }
    expect(requestAfterSave(request)).toBe(request)
  })

  it('keeps an invalid binary reference, which the save wrote back', () => {
    const request: RequestEditorState = {
      ...DEFAULT_REQUEST_STATE,
      bodyType: 'binary',
      invalidBinaryRef: 'not-a-ref'
    }
    expect(requestAfterSave(request).invalidBinaryRef).toBe('not-a-ref')
  })
})
