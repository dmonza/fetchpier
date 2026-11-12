import { describe, expect, it } from 'vitest'
import { parseHttpFile } from './parser'
import { sanitizeOriginalName } from './binary-store'
import { serializeRequest } from '@shared/lib/http-serializer'
import { DEFAULT_REQUEST_STATE } from '@shared/types'
import type { MultipartFilePart, MultipartTextPart, RequestEditorState } from '@shared/types'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const REF_A = `${HASH_A}__beach.jpg`
const REF_B = `${HASH_B}__sunset.jpg`

function state(overrides: Partial<RequestEditorState> = {}): RequestEditorState {
  return {
    ...DEFAULT_REQUEST_STATE,
    method: 'POST',
    url: 'https://example.com/upload',
    bodyType: 'multipart-form',
    multipartParts: [],
    ...overrides
  }
}

function textPart(
  id: string,
  name: string,
  value: string,
  overrides: Partial<MultipartTextPart> = {}
): MultipartTextPart {
  return { kind: 'text', id, name, value, ...overrides }
}

function filePart(
  id: string,
  name: string,
  ref: string,
  originalName: string,
  sizeBytes: number,
  mimeType: string,
  overrides: Partial<MultipartFilePart> = {}
): MultipartFilePart {
  return {
    kind: 'file',
    id,
    name,
    file: { ref, originalName, sizeBytes, mimeType },
    ...overrides
  }
}

describe('multipart round-trip (CA-02)', () => {
  it('survives serialize → parse with 2 text + 2 file parts (one non-ASCII filename)', () => {
    const original = state({
      multipartParts: [
        textPart('mp-0', 'album', '{{albumId}}'),
        textPart('mp-1', 'meta', '{"a":1}', { contentType: 'application/json' }),
        filePart('mp-2', 'photo', REF_A, 'beach.jpg', 184_200, 'image/jpeg'),
        filePart('mp-3', 'photo', REF_B, 'sunset.jpg', 211_700, 'image/jpeg', {
          filename: 'café-sunset.jpg'
        })
      ]
    })

    const text = serializeRequest(original)
    const parsed = parseHttpFile(text)
    expect(parsed.requests).toHaveLength(1)

    const req = parsed.requests[0]
    expect(req.bodyType).toBe('multipart-form')
    expect(req.body).toBeUndefined()
    expect(req.multipartParts).toHaveLength(4)

    expect(req.multipartParts![0]).toMatchObject({
      kind: 'text',
      name: 'album',
      value: '{{albumId}}'
    })
    expect(req.multipartParts![1]).toMatchObject({
      kind: 'text',
      name: 'meta',
      value: '{"a":1}',
      contentType: 'application/json'
    })
    expect(req.multipartParts![2]).toMatchObject({
      kind: 'file',
      name: 'photo'
    })
    if (req.multipartParts![2].kind === 'file') {
      expect(req.multipartParts![2].file.ref).toBe(REF_A)
    }
    expect(req.multipartParts![3]).toMatchObject({
      kind: 'file',
      name: 'photo',
      filename: 'café-sunset.jpg'
    })
  })

  it('a file ref whose staged name has spaces round-trips whole (FMT-04)', () => {
    const name = sanitizeOriginalName('C:/Users/me/My Report 2026.pdf')
    const ref = `${HASH_A}__${name}`
    const original = state({
      // Size 0: the parser does not read it, and the preview prints it.
      multipartParts: [filePart('mp-0', 'doc', ref, name, 0, 'application/pdf')]
    })
    const text = serializeRequest(original)
    expect(text).toContain(`file="${ref}"`)
    const parsed = parseHttpFile(text)
    expect(parsed.warnings).toBeUndefined()
    const part = parsed.requests[0].multipartParts![0]
    expect(part).toMatchObject({ kind: 'file', name: 'doc' })
    expect(part.disabled).toBeFalsy()
    if (part.kind === 'file') expect(part.file.ref).toBe(ref)
    // A second save writes the same bytes.
    const reparsed = parsed.requests[0].multipartParts!
    expect(serializeRequest(state({ multipartParts: reparsed }))).toBe(text)
  })

  it('a file ref with no special characters stays unquoted (FMT-04)', () => {
    const text = serializeRequest(
      state({ multipartParts: [filePart('mp-0', 'photo', REF_A, 'beach.jpg', 1, 'image/jpeg')] })
    )
    expect(text).toContain(`file=${REF_A}`)
    expect(text).not.toContain(`file="${REF_A}"`)
  })

  it('preserves disabled parts through round-trip (CA-12)', () => {
    const original = state({
      multipartParts: [
        textPart('mp-0', 'kept', 'yes'),
        textPart('mp-1', 'draft', 'no', { disabled: true })
      ]
    })
    const text = serializeRequest(original)
    const parsed = parseHttpFile(text)
    expect(parsed.requests[0].multipartParts).toHaveLength(2)
    expect(parsed.requests[0].multipartParts![1].disabled).toBe(true)
  })

  it('CA-15: the preview is ignored on parse even when it contradicts the markers', () => {
    // Build a marker block by hand with a preview block that describes a
    // completely different request shape. The parser must obey the markers.
    const handBuilt =
      `# @id 11111111-2222-3333-4444-555555555555\n` +
      `POST https://example.com/x\n` +
      `\n` +
      `# @multipart begin\n` +
      `# @multipart-part name=a type=text\n` +
      `AAA\n` +
      `# @multipart-part name=b type=text\n` +
      `BBB\n` +
      `# @multipart-part name=c type=text\n` +
      `CCC\n` +
      `# @multipart end\n` +
      `# @multipart-preview begin\n` +
      `# Tampered preview that lies about the parts.\n` +
      `Content-Type: multipart/form-data; boundary=<generated-at-send>\n` +
      `\n` +
      `--<boundary>\n` +
      `Content-Disposition: form-data; name="x"\n` +
      `\n` +
      `tampered\n` +
      `--<boundary>--\n` +
      `# @multipart-preview end\n`
    const parsed = parseHttpFile(handBuilt)
    const parts = parsed.requests[0].multipartParts!
    expect(parts.map((p) => p.name)).toEqual(['a', 'b', 'c'])
  })

  it('CA-13: tampered preview content is overwritten by the serializer', () => {
    const tampered =
      `POST https://example.com/x\n\n` +
      `# @multipart begin\n` +
      `# @multipart-part name=z type=text\n` +
      `Z\n` +
      `# @multipart end\n` +
      `# @multipart-preview begin\n` +
      `# garbage tampered preview\n` +
      `--<boundary>--\n` +
      `# @multipart-preview end\n`
    const parsed = parseHttpFile(tampered)
    const re = serializeRequest({
      ...DEFAULT_REQUEST_STATE,
      method: parsed.requests[0].method,
      url: parsed.requests[0].url,
      bodyType: 'multipart-form',
      multipartParts: parsed.requests[0].multipartParts
    })
    expect(re).toContain('# Auto-generated representation of the wire')
    expect(re).not.toContain('garbage tampered')
  })

  it('handles a multi-line heredoc text value through round-trip', () => {
    const original = state({
      multipartParts: [
        textPart('mp-0', 'meta', '{\n  "a": 1,\n\n  "b": 2\n}', {
          contentType: 'application/json'
        })
      ]
    })
    const text = serializeRequest(original)
    const parsed = parseHttpFile(text)
    const p = parsed.requests[0].multipartParts![0]
    expect(p.kind).toBe('text')
    expect((p as { value: string }).value).toBe('{\n  "a": 1,\n\n  "b": 2\n}')
  })
})
