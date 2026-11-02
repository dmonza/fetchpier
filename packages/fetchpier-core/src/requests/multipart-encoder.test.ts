import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MultipartFilePart, MultipartPart, MultipartTextPart } from '@shared/types'
import { asciiTransliterate, percentEncodeRfc5987 } from '@shared/lib/multipart-format'
import { encodeContentDisposition, encodeMultipart, generateBoundary } from './multipart-encoder'
import { stageBinary } from './binary-store'

function textPart(
  name: string,
  value: string,
  overrides: Partial<MultipartTextPart> = {}
): MultipartTextPart {
  return { kind: 'text', id: `t-${name}`, name, value, ...overrides }
}

async function stagedFilePart(
  workspacePath: string,
  name: string,
  filename: string,
  content: Buffer | string,
  overrides: Partial<MultipartFilePart> = {}
): Promise<MultipartFilePart> {
  const src = join(workspacePath, filename)
  await fs.writeFile(src, content)
  const staged = await stageBinary(workspacePath, src)
  return {
    kind: 'file',
    id: `f-${name}`,
    name,
    file: {
      ref: staged.ref,
      originalName: staged.originalName,
      sizeBytes: staged.sizeBytes,
      mimeType: staged.mimeType
    },
    ...overrides
  }
}

describe('multipart-encoder', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'core-mp-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  describe('generateBoundary', () => {
    it('emits a fetchpier- prefixed boundary with sufficient entropy', () => {
      const b = generateBoundary()
      expect(b.startsWith('fetchpier-')).toBe(true)
      // 32 random bytes → base64url ≈ 43 chars. Total ≥ 50.
      expect(b.length).toBeGreaterThanOrEqual(50)
      // RFC 2046 bcharsnospace: alnum, -, _ (base64url alphabet).
      expect(b).toMatch(/^fetchpier-[A-Za-z0-9_-]+$/)
    })

    it('never returns a value containing "--"', () => {
      for (let i = 0; i < 200; i += 1) {
        expect(generateBoundary().includes('--')).toBe(false)
      }
    })

    it('returns distinct boundaries (probabilistically) across calls', () => {
      const a = generateBoundary()
      const b = generateBoundary()
      expect(a).not.toBe(b)
    })
  })

  describe('percentEncodeRfc5987', () => {
    it('leaves attr-char bytes unchanged', () => {
      expect(percentEncodeRfc5987('abcXYZ012')).toBe('abcXYZ012')
      expect(percentEncodeRfc5987('!#$&+-.^_`|~')).toBe('!#$&+-.^_`|~')
    })

    it('percent-encodes spaces and punctuation outside attr-char', () => {
      // Space is not in attr-char.
      expect(percentEncodeRfc5987('a b')).toBe('a%20b')
      expect(percentEncodeRfc5987('a*b')).toBe('a%2Ab')
      expect(percentEncodeRfc5987('a/b')).toBe('a%2Fb')
    })

    it('percent-encodes non-ASCII via UTF-8 bytes', () => {
      expect(percentEncodeRfc5987('café')).toBe('caf%C3%A9')
      expect(percentEncodeRfc5987('日本')).toBe('%E6%97%A5%E6%9C%AC')
    })
  })

  describe('asciiTransliterate', () => {
    it('keeps ASCII characters', () => {
      expect(asciiTransliterate('hello.jpg')).toBe('hello.jpg')
    })
    it('replaces non-ASCII with ?', () => {
      expect(asciiTransliterate('café.jpg')).toBe('caf?.jpg')
      expect(asciiTransliterate('日本.png')).toBe('??.png')
    })
  })

  describe('encodeContentDisposition', () => {
    it('emits form-data; name="..." for a text part', () => {
      const p = textPart('field1', 'value')
      expect(encodeContentDisposition(p)).toBe('form-data; name="field1"')
    })

    it('escapes quotes and backslashes in the name', () => {
      const p = textPart('he said "hi" \\path', 'value')
      expect(encodeContentDisposition(p)).toBe('form-data; name="he said \\"hi\\" \\\\path"')
    })

    it('emits ASCII filename for safe wire-filename', async () => {
      const p = await stagedFilePart(dir, 'photo', 'beach.jpg', 'x')
      expect(encodeContentDisposition(p, 'beach.jpg')).toBe(
        'form-data; name="photo"; filename="beach.jpg"'
      )
    })

    it('emits both filename= and filename*=UTF-8 for non-ASCII wire-filename', async () => {
      const p = await stagedFilePart(dir, 'photo', 'cafe-sunset.jpg', 'x')
      const result = encodeContentDisposition(p, 'café-sunset.jpg')
      expect(result).toContain(`filename="caf?-sunset.jpg"`)
      expect(result).toContain(`filename*=UTF-8''caf%C3%A9-sunset.jpg`)
    })

    it('escapes filename= when it contains quote or backslash even if pure ASCII', () => {
      // Filenames containing %, ", \, CR, LF, or non-ASCII trigger the
      // RFC 5987 path. Bare quotes / backslashes therefore go through
      // ASCII transliteration + escapeQuoted (the chars are ASCII so they
      // survive transliteration, then get backslash-escaped).
      const p: MultipartFilePart = {
        kind: 'file',
        id: 'f-x',
        name: 'photo',
        file: {
          ref: 'a'.repeat(64) + '__x',
          originalName: 'x',
          sizeBytes: 0,
          mimeType: 'image/jpeg'
        }
      }
      const result = encodeContentDisposition(p, 'odd"name.jpg')
      // The escaped fallback contains the backslash-escaped quote.
      expect(result).toContain('filename="odd\\"name.jpg"')
      expect(result).toContain(`filename*=UTF-8''odd%22name.jpg`)
    })

    it('throws MULTIPART_INVALID_PART when the part name contains CR/LF', () => {
      expect(() => encodeContentDisposition(textPart('bad\rname', 'v'))).toThrow(/CR or LF/)
      expect(() => encodeContentDisposition(textPart('bad\nname', 'v'))).toThrow(/CR or LF/)
    })

    it('throws MULTIPART_INVALID_PART when filename contains CR/LF', async () => {
      const p = await stagedFilePart(dir, 'f', 'a.jpg', 'x')
      expect(() => encodeContentDisposition(p, 'bad\rname')).toThrow(/CR or LF/)
    })
  })

  describe('encodeMultipart', () => {
    async function decodeBody(buf: Buffer): Promise<string> {
      return buf.toString('utf8')
    }

    it('encodes a single text part with the closing boundary', async () => {
      const parts: MultipartPart[] = [textPart('field', 'hello')]
      const { contentType, body, boundary } = await encodeMultipart(parts, { workspacePath: dir })
      expect(contentType).toBe(`multipart/form-data; boundary=${boundary}`)
      const text = await decodeBody(body)
      expect(text).toBe(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="field"\r\n` +
          `\r\n` +
          `hello\r\n` +
          `--${boundary}--\r\n`
      )
    })

    it('skips disabled parts (CA-12)', async () => {
      const parts: MultipartPart[] = [
        textPart('keep', 'yes'),
        textPart('skip', 'no', { disabled: true })
      ]
      const { body, boundary } = await encodeMultipart(parts, { workspacePath: dir })
      const text = await decodeBody(body)
      expect(text).toContain(`name="keep"`)
      expect(text).not.toContain(`name="skip"`)
      expect(text).toContain(`--${boundary}--\r\n`)
    })

    it('emits Content-Type when set on a text part, otherwise omits it', async () => {
      const parts: MultipartPart[] = [
        textPart('plain', 'aaa'),
        textPart('json', '{}', { contentType: 'application/json' })
      ]
      const { body } = await encodeMultipart(parts, { workspacePath: dir })
      const text = await decodeBody(body)
      const plainBlock = text.split(/(?:--[A-Za-z0-9_-]+\r\n)|(?:--[A-Za-z0-9_-]+--\r\n)/)[1]
      const jsonBlock = text.split(/(?:--[A-Za-z0-9_-]+\r\n)|(?:--[A-Za-z0-9_-]+--\r\n)/)[2]
      expect(plainBlock).not.toContain('Content-Type:')
      expect(jsonBlock).toContain('Content-Type: application/json')
    })

    it('reads file bytes and emits with the staged mime as Content-Type (file part)', async () => {
      const filePart = await stagedFilePart(dir, 'photo', 'a.jpg', Buffer.from([0x01, 0x02, 0x03]))
      const { body, boundary } = await encodeMultipart([filePart], { workspacePath: dir })
      const expected = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="photo"; filename="a.jpg"\r\n` +
            `Content-Type: image/jpeg\r\n` +
            `\r\n`,
          'utf8'
        ),
        Buffer.from([0x01, 0x02, 0x03]),
        Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
      ])
      expect(body.equals(expected)).toBe(true)
    })

    it('overrides Content-Type for a file part when explicitly set', async () => {
      const fp = await stagedFilePart(dir, 'doc', 'a.bin', 'xy', { contentType: 'custom/foo' })
      const { body } = await encodeMultipart([fp], { workspacePath: dir })
      expect(body.toString('utf8')).toContain('Content-Type: custom/foo')
    })

    it('falls back to application/octet-stream when neither override nor mime is set', async () => {
      const fp: MultipartFilePart = {
        kind: 'file',
        id: 'x',
        name: 'doc',
        file: {
          ref: 'a'.repeat(64) + '__unknown',
          originalName: 'unknown',
          sizeBytes: 0,
          mimeType: ''
        }
      }
      // Stage by hand to match the ref above.
      await fs.mkdir(join(dir, 'requests', '.files'), { recursive: true })
      await fs.writeFile(join(dir, 'requests', '.files', fp.file.ref), Buffer.alloc(0))
      const { body } = await encodeMultipart([fp], { workspacePath: dir })
      expect(body.toString('utf8')).toContain('Content-Type: application/octet-stream')
    })

    it('emits filename*=UTF-8 for non-ASCII wire-filename (CA-09)', async () => {
      const fp = await stagedFilePart(dir, 'photo', 'cafe.jpg', 'x', { filename: 'café.jpg' })
      const { body } = await encodeMultipart([fp], { workspacePath: dir })
      const text = body.toString('utf8')
      expect(text).toContain(`filename="caf?.jpg"`)
      expect(text).toContain(`filename*=UTF-8''caf%C3%A9.jpg`)
    })

    it('uses the overridden filename when set, else the staged original', async () => {
      const fp = await stagedFilePart(dir, 'photo', 'a.jpg', 'x', { filename: 'pretty.jpg' })
      const { body } = await encodeMultipart([fp], { workspacePath: dir })
      expect(body.toString('utf8')).toContain('filename="pretty.jpg"')
    })

    it('encodes multi-file under the same name (one marker per file)', async () => {
      const f1 = await stagedFilePart(dir, 'photo', 'a.jpg', 'A')
      const f2 = await stagedFilePart(dir, 'photo', 'b.jpg', 'B')
      const { body } = await encodeMultipart([f1, f2], { workspacePath: dir })
      const text = body.toString('utf8')
      const matches = text.match(/name="photo"/g)
      expect(matches?.length).toBe(2)
    })

    it('produces a minimal body for an empty parts list (closing boundary only)', async () => {
      const { body, boundary } = await encodeMultipart([], { workspacePath: dir })
      expect(body.toString('utf8')).toBe(`--${boundary}--\r\n`)
    })

    it('respects an overridden boundary (used for desktop/CLI parity tests)', async () => {
      const fixed = 'fetchpier-fixed-for-tests'
      const { boundary, contentType } = await encodeMultipart([textPart('a', 'b')], {
        workspacePath: dir,
        boundary: fixed
      })
      expect(boundary).toBe(fixed)
      expect(contentType).toBe(`multipart/form-data; boundary=${fixed}`)
    })

    it('rejects an overridden boundary that collides with a part body', async () => {
      const colliding = 'fetchpier-COLLIDE'
      const parts: MultipartPart[] = [textPart('x', `before--${colliding}after`)]
      await expect(
        encodeMultipart(parts, { workspacePath: dir, boundary: colliding })
      ).rejects.toThrow(/BOUNDARY_COLLISION|appears as/)
    })

    it('throws MULTIPART_FILE_MISSING when a file part references an unknown ref', async () => {
      const fp: MultipartFilePart = {
        kind: 'file',
        id: 'x',
        name: 'doc',
        file: {
          ref: 'b'.repeat(64) + '__nope.bin',
          originalName: 'nope.bin',
          sizeBytes: 0,
          mimeType: ''
        }
      }
      await expect(encodeMultipart([fp], { workspacePath: dir })).rejects.toThrow(/missing file/)
    })
  })
})
