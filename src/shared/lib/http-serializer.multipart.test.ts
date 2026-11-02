import { describe, expect, it } from 'vitest'
import { serializeRequest } from './http-serializer'
import { DEFAULT_REQUEST_STATE } from '../types'
import type {
  MultipartFilePart,
  MultipartPart,
  MultipartTextPart,
  RequestEditorState
} from '../types'

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

describe('serializeRequest — multipart-form body', () => {
  it('emits @multipart begin/end followed by the preview block', () => {
    const out = serializeRequest(
      state({
        multipartParts: [textPart('mp-0', 'field', 'hello')]
      })
    )
    expect(out).toContain('# @multipart begin')
    expect(out).toContain('# @multipart-part name=field type=text')
    expect(out).toContain('hello')
    expect(out).toContain('# @multipart end')
    expect(out).toContain('# @multipart-preview begin')
    expect(out).toContain('# @multipart-preview end')
  })

  it('CA-17: does NOT write Content-Type into the real headers section', () => {
    const out = serializeRequest(
      state({
        // User somehow has Content-Type in headers; serializer must strip.
        headers: [
          {
            id: 'h-1',
            key: 'Content-Type',
            value: 'multipart/form-data; boundary=xxx',
            enabled: true
          }
        ],
        multipartParts: [textPart('mp-0', 'field', 'hello')]
      })
    )
    // Split headers section from body.
    const beforeMultipart = out.split('# @multipart begin')[0]
    expect(beforeMultipart.toLowerCase()).not.toContain('content-type: multipart')
    // But the preview must still show the CT line.
    const previewSection = out.slice(out.indexOf('# @multipart-preview begin'))
    expect(previewSection).toContain(
      'Content-Type: multipart/form-data; boundary=<generated-at-send>'
    )
  })

  it('CA-12: persists disabled parts in markers but excludes them from preview (CA-14)', () => {
    const out = serializeRequest(
      state({
        multipartParts: [
          textPart('mp-0', 'a', 'aaa'),
          textPart('mp-1', 'middle', 'skipped', { disabled: true }),
          textPart('mp-2', 'b', 'bbb')
        ]
      })
    )
    const markers = out.slice(out.indexOf('# @multipart begin'), out.indexOf('# @multipart end'))
    expect(markers).toContain('name=middle')
    expect(markers).toContain('disabled=true')
    const preview = out.slice(
      out.indexOf('# @multipart-preview begin'),
      out.indexOf('# @multipart-preview end')
    )
    // The preview must NOT contain the disabled part's body.
    expect(preview).not.toContain('skipped')
    // It must contain the two enabled parts' content.
    expect(preview).toContain('aaa')
    expect(preview).toContain('bbb')
    // Boundary fences: 2 `--<boundary>` + 1 `--<boundary>--`
    const fenceMatches = preview.match(/^--<boundary>(--)?$/gm)
    expect(fenceMatches?.length).toBe(3)
  })

  it('CA-18: every wire-shaped line inside the preview block lacks the # prefix (only the disclaimer is commented)', () => {
    const out = serializeRequest(
      state({
        multipartParts: [
          textPart('mp-0', 'x', 'value-x'),
          filePart('mp-1', 'photo', REF_A, 'beach.jpg', 1024, 'image/jpeg')
        ]
      })
    )
    const previewLines = out.slice(out.indexOf('# @multipart-preview begin')).split('\n')
    // The first line is the begin marker; the second line is the disclaimer
    // (the only commented body line); the rest must NOT start with `# `.
    expect(previewLines[0]).toMatch(/^# @multipart-preview begin\s*$/)
    expect(previewLines[1]).toMatch(/^# /)
    // From line 2 (Content-Type:) up to (but not including) the end marker.
    const endIdx = previewLines.findIndex((l) => l === '# @multipart-preview end')
    expect(endIdx).toBeGreaterThan(2)
    for (let i = 2; i < endIdx; i += 1) {
      const ln = previewLines[i]
      // Allow blank lines.
      if (ln.trim() === '') continue
      expect(ln.startsWith('# ')).toBe(false)
    }
  })

  it('emits filename*=UTF-8 in the preview for non-ASCII wire-filename', () => {
    const fp = filePart('mp-0', 'photo', REF_B, 'sunset.jpg', 211_700, 'image/jpeg', {
      filename: 'café.jpg'
    })
    const out = serializeRequest(state({ multipartParts: [fp] }))
    const preview = out.slice(out.indexOf('# @multipart-preview begin'))
    expect(preview).toContain(`filename="caf?.jpg"`)
    expect(preview).toContain(`filename*=UTF-8''caf%C3%A9.jpg`)
  })

  it('CA-16: serialise → parse-by-splitting → serialise is byte-identical (idempotent save)', () => {
    const s = state({
      multipartParts: [
        textPart('mp-0', 'album', '{{albumId}}'),
        textPart('mp-1', 'meta', '{"a":1}', { contentType: 'application/json' }),
        filePart('mp-2', 'photo', REF_A, 'beach.jpg', 184_200, 'image/jpeg')
      ]
    })
    const first = serializeRequest(s)
    const second = serializeRequest(s)
    expect(second).toBe(first)
  })

  it('emits a heredoc for multi-line text values', () => {
    const out = serializeRequest(
      state({
        multipartParts: [textPart('mp-0', 'meta', '{\n  "a": 1\n}')]
      })
    )
    expect(out).toContain('<<<EOT')
    expect(out).toMatch(/^EOT$/m)
    expect(out).toContain('"a": 1')
  })

  it('escapes attribute values containing spaces or quotes', () => {
    const out = serializeRequest(
      state({
        multipartParts: [textPart('mp-0', 'odd "name" here', 'v')]
      })
    )
    expect(out).toContain('name="odd \\"name\\" here"')
  })

  it('emits content-type attribute on the marker when set', () => {
    const out = serializeRequest(
      state({
        multipartParts: [textPart('mp-0', 'meta', 'v', { contentType: 'application/json' })]
      })
    )
    expect(out).toContain('content-type=application/json')
  })

  it('supports multi-file under the same name (one marker per file)', () => {
    const out = serializeRequest(
      state({
        multipartParts: [
          filePart('mp-0', 'photo', REF_A, 'a.jpg', 10, 'image/jpeg'),
          filePart('mp-1', 'photo', REF_B, 'b.jpg', 20, 'image/jpeg')
        ]
      })
    )
    const markerMatches = out.match(/^# @multipart-part name=photo /gm)
    expect(markerMatches?.length).toBe(2)
  })

  it('an empty parts list still emits the marker and preview blocks', () => {
    const out = serializeRequest(state({ multipartParts: [] }))
    expect(out).toContain('# @multipart begin')
    expect(out).toContain('# @multipart end')
    expect(out).toContain('# @multipart-preview begin')
    // Preview body is just the Content-Type + closing fence.
    const preview = out.slice(
      out.indexOf('# @multipart-preview begin'),
      out.indexOf('# @multipart-preview end')
    )
    expect(preview).toContain('--<boundary>--')
  })

  it('renders byte-shaped file part bodies as <bytes of <ref> — <size>>', () => {
    const out = serializeRequest(
      state({
        multipartParts: [filePart('mp-0', 'photo', REF_A, 'beach.jpg', 184_200, 'image/jpeg')]
      })
    )
    const preview = out.slice(out.indexOf('# @multipart-preview begin'))
    expect(preview).toContain(`<bytes of ${REF_A} — 179.9 KB>`)
  })

  it('does not strip non-multipart Content-Type headers (raw mode unaffected)', () => {
    const parts: MultipartPart[] = []
    void parts
    const out = serializeRequest(
      state({
        bodyType: 'raw',
        body: '{"x":1}',
        headers: [{ id: 'h-1', key: 'Content-Type', value: 'application/json', enabled: true }],
        multipartParts: undefined
      })
    )
    expect(out).toContain('Content-Type: application/json')
  })
})
