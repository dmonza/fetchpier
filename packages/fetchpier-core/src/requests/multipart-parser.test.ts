import { describe, expect, it } from 'vitest'
import {
  parseMultipartBlock,
  parsePartAttributeList,
  parseHeredocOpener,
  skipPreviewBlock,
  MULTIPART_BEGIN_MARKER,
  MULTIPART_END_MARKER,
  MULTIPART_PART_MARKER,
  MULTIPART_PREVIEW_BEGIN_MARKER,
  MULTIPART_PREVIEW_END_MARKER
} from './multipart-parser'

const HASH = 'a'.repeat(64)
const REF = `${HASH}__beach.jpg`

describe('multipart-parser regex shapes', () => {
  it('recognises the begin/end markers', () => {
    expect(MULTIPART_BEGIN_MARKER.test('# @multipart begin')).toBe(true)
    expect(MULTIPART_BEGIN_MARKER.test('  #   @multipart   begin  ')).toBe(true)
    expect(MULTIPART_END_MARKER.test('# @multipart end')).toBe(true)
    expect(MULTIPART_END_MARKER.test('# @multipart endish')).toBe(false)
  })

  it('recognises the part marker with attribute tail', () => {
    const m = MULTIPART_PART_MARKER.exec('# @multipart-part name=x type=text')
    expect(m).not.toBeNull()
    expect(m![1].trim()).toBe('name=x type=text')
  })

  it('recognises the preview begin/end markers', () => {
    expect(MULTIPART_PREVIEW_BEGIN_MARKER.test('# @multipart-preview begin')).toBe(true)
    expect(MULTIPART_PREVIEW_END_MARKER.test('# @multipart-preview end')).toBe(true)
  })
})

describe('parsePartAttributeList', () => {
  it('parses simple unquoted key=value pairs', () => {
    expect(parsePartAttributeList('name=field1 type=text')).toEqual([
      { key: 'name', value: 'field1', quoted: false },
      { key: 'type', value: 'text', quoted: false }
    ])
  })

  it('parses quoted values with embedded spaces', () => {
    expect(parsePartAttributeList('name="hello world" type=text')).toEqual([
      { key: 'name', value: 'hello world', quoted: true },
      { key: 'type', value: 'text', quoted: false }
    ])
  })

  it('unescapes \\" and \\\\ inside quoted values', () => {
    const result = parsePartAttributeList('name="a\\"b\\\\c"')
    expect(result).toEqual([{ key: 'name', value: 'a"b\\c', quoted: true }])
  })

  it('parses a file-ref-shaped unquoted token', () => {
    expect(parsePartAttributeList(`file=${REF}`)).toEqual([
      { key: 'file', value: REF, quoted: false }
    ])
  })

  it('parses multiple mixed attributes', () => {
    const r = parsePartAttributeList(
      'name=photo type=file file=' +
        REF +
        ' filename="café.jpg" content-type=image/jpeg disabled=true'
    )
    expect(r.map((a) => a.key)).toEqual([
      'name',
      'type',
      'file',
      'filename',
      'content-type',
      'disabled'
    ])
    expect(r.find((a) => a.key === 'filename')!.value).toBe('café.jpg')
  })

  it('records lone tokens with no =', () => {
    const r = parsePartAttributeList('name=x rogueflag type=text')
    expect(r).toEqual([
      { key: 'name', value: 'x', quoted: false },
      { key: 'rogueflag', value: '', quoted: false },
      { key: 'type', value: 'text', quoted: false }
    ])
  })

  it('tolerates trailing whitespace', () => {
    expect(parsePartAttributeList('  name=x   type=text   ').map((a) => a.key)).toEqual([
      'name',
      'type'
    ])
  })
})

describe('parseHeredocOpener', () => {
  it('recognises <<<DELIM with no trailing whitespace garbage', () => {
    expect(parseHeredocOpener('<<<EOT')).toEqual({ delimiter: 'EOT' })
    expect(parseHeredocOpener('<<<JSON_END  ')).toEqual({ delimiter: 'JSON_END' })
  })

  it('rejects malformed openers', () => {
    expect(parseHeredocOpener('<<<')).toBeNull()
    expect(parseHeredocOpener('something else')).toBeNull()
    expect(parseHeredocOpener('<< EOT')).toBeNull()
  })
})

describe('parseMultipartBlock', () => {
  function blockLines(...lines: string[]): string[] {
    return ['# @multipart begin', ...lines, '# @multipart end']
  }

  it('parses a single text part with an inline value', () => {
    const lines = blockLines('# @multipart-part name=field type=text', 'hello')
    const r = parseMultipartBlock(lines, 0)
    expect(r.warnings).toEqual([])
    expect(r.parts).toHaveLength(1)
    expect(r.parts[0]).toMatchObject({
      kind: 'text',
      name: 'field',
      value: 'hello',
      disabled: undefined
    })
    expect(r.endIdx).toBe(lines.length)
  })

  it('parses a text part with a heredoc value (preserves blank lines)', () => {
    const lines = blockLines(
      '# @multipart-part name=metadata type=text content-type=application/json',
      '<<<EOT',
      '{',
      '  "a": 1,',
      '',
      '  "b": 2',
      '}',
      'EOT'
    )
    const r = parseMultipartBlock(lines, 0)
    expect(r.parts).toHaveLength(1)
    const p = r.parts[0]
    expect(p.kind).toBe('text')
    expect((p as { value: string }).value).toBe('{\n  "a": 1,\n\n  "b": 2\n}')
    expect((p as { contentType?: string }).contentType).toBe('application/json')
  })

  it('parses a file part', () => {
    const lines = blockLines(
      `# @multipart-part name=photo type=file file=${REF} filename="beach.jpg" content-type=image/jpeg`
    )
    const r = parseMultipartBlock(lines, 0)
    expect(r.warnings).toEqual([])
    expect(r.parts).toHaveLength(1)
    const p = r.parts[0]
    expect(p.kind).toBe('file')
    if (p.kind === 'file') {
      expect(p.file.ref).toBe(REF)
      expect(p.file.originalName).toBe('beach.jpg')
      expect(p.filename).toBe('beach.jpg')
      expect(p.contentType).toBe('image/jpeg')
      expect(p.disabled).toBeUndefined()
    }
  })

  it('parses a disabled part and preserves the flag', () => {
    const lines = blockLines('# @multipart-part name=draft type=text disabled=true', 'kept on disk')
    const r = parseMultipartBlock(lines, 0)
    expect(r.parts[0].disabled).toBe(true)
    expect((r.parts[0] as { value: string }).value).toBe('kept on disk')
  })

  it('parses multiple text + file parts in order', () => {
    const lines = blockLines(
      '# @multipart-part name=album type=text',
      'A1',
      `# @multipart-part name=photo type=file file=${REF}`,
      '# @multipart-part name=meta type=text',
      'XYZ'
    )
    const r = parseMultipartBlock(lines, 0)
    expect(r.parts.map((p) => p.name)).toEqual(['album', 'photo', 'meta'])
    expect(r.parts.map((p) => p.kind)).toEqual(['text', 'file', 'text'])
  })

  it('warns on missing required attribute and marks the part disabled (REQ §5.2 rule 8)', () => {
    const lines = blockLines('# @multipart-part type=text', 'orphan value')
    const r = parseMultipartBlock(lines, 0)
    expect(r.warnings.join('\n')).toMatch(/missing required attribute "name"/)
    expect(r.parts[0].disabled).toBe(true)
  })

  it('warns on conflicting attributes (text part with file=)', () => {
    const lines = blockLines(`# @multipart-part name=bad type=text file=${REF}`)
    const r = parseMultipartBlock(lines, 0)
    expect(r.warnings.join('\n')).toMatch(/text part cannot have "file"/)
    expect(r.parts[0].disabled).toBe(true)
  })

  it('rejects {{var}} inside file= as MULTIPART_INVALID_PART', () => {
    const lines = blockLines('# @multipart-part name=p type=file file={{somePath}}')
    const r = parseMultipartBlock(lines, 0)
    expect(r.warnings.join('\n')).toMatch(/MULTIPART_INVALID_PART.*variable interpolation/)
    expect(r.parts[0].disabled).toBe(true)
  })

  it('rejects malformed file ref shape', () => {
    const lines = blockLines('# @multipart-part name=p type=file file=not-a-ref')
    const r = parseMultipartBlock(lines, 0)
    expect(r.warnings.join('\n')).toMatch(/MULTIPART_INVALID_PART.*invalid file ref/)
    expect(r.parts[0].disabled).toBe(true)
  })

  // A file part that fails validation stays a file part carrying `parseError`,
  // so a save removes it honestly. Downgrading it to a text part (which has no
  // `parseError`) made the save rewrite it as `type=text`, dropping the
  // reference without notice.
  describe('an invalid file part stays a file part with parseError', () => {
    it.each([
      ['an invalid reference shape', 'file=not-a-ref', 'not-a-ref', /invalid file ref/],
      ['a variable reference', 'file={{somePath}}', '{{somePath}}', /variable interpolation/],
      ['no reference at all', '', '', /missing required attribute "file"/]
    ])('%s', (_label, fileAttr, ref, error) => {
      const r = parseMultipartBlock(
        blockLines(`# @multipart-part name=avatar type=file ${fileAttr} filename=me.png`.trim()),
        0
      )
      const part = r.parts[0]
      expect(part.kind).toBe('file')
      if (part.kind !== 'file') return
      expect(part.name).toBe('avatar')
      expect(part.file.ref).toBe(ref)
      expect(part.filename).toBe('me.png')
      expect(part.disabled).toBe(true)
      expect(part.parseError).toMatch(error)
      // The diagnostic is still reported, and marked as carried by the part.
      expect(r.warnings.join('\n')).toMatch(error)
      expect(r.representedWarnings).toEqual(r.warnings.filter((w) => error.test(w)))
    })

    it('a valid reference with a missing name is carried by the part too', () => {
      const r = parseMultipartBlock(blockLines(`# @multipart-part type=file file=${REF}`), 0)
      expect(r.parts[0]).toMatchObject({ kind: 'file', disabled: true })
      expect(r.representedWarnings).toEqual([
        'Multipart part "(no name)": missing required attribute "name"'
      ])
    })

    it('an invalid text part is not carried by a part, only reported', () => {
      const r = parseMultipartBlock(blockLines('# @multipart-part type=text', 'orphan value'), 0)
      expect(r.parts[0].kind).toBe('text')
      expect(r.warnings).toHaveLength(1)
      expect(r.representedWarnings).toEqual([])
    })

    it('an unknown attribute on an invalid file part is reported, not carried', () => {
      const r = parseMultipartBlock(
        blockLines('# @multipart-part name=p type=file file=bad rogue=1'),
        0
      )
      expect(r.warnings.some((w) => /unknown attribute "rogue"/.test(w))).toBe(true)
      expect(r.representedWarnings.some((w) => /rogue/.test(w))).toBe(false)
    })
  })

  it('warns on unknown attribute and skips it', () => {
    const lines = blockLines(`# @multipart-part name=x type=text rogue=val`, 'v')
    const r = parseMultipartBlock(lines, 0)
    expect(r.warnings.join('\n')).toMatch(/unknown attribute "rogue"/)
    expect(r.parts[0].disabled).toBeUndefined()
  })

  it('warns on stray content before the first part marker', () => {
    const lines = [
      '# @multipart begin',
      'stray junk',
      '# @multipart-part name=x type=text',
      'v',
      '# @multipart end'
    ]
    const r = parseMultipartBlock(lines, 0)
    expect(r.warnings.join('\n')).toMatch(/stray content before first/)
    expect(r.parts).toHaveLength(1)
  })

  it('warns on missing # @multipart end and still returns parsed parts', () => {
    const lines = ['# @multipart begin', '# @multipart-part name=x type=text', 'v']
    const r = parseMultipartBlock(lines, 0)
    expect(r.warnings.join('\n')).toMatch(/missing closing # @multipart end/)
    expect(r.parts).toHaveLength(1)
  })

  it('warns on unterminated heredoc', () => {
    const lines = [
      '# @multipart begin',
      '# @multipart-part name=x type=text',
      '<<<EOT',
      'line1',
      'line2',
      '# @multipart end'
    ]
    const r = parseMultipartBlock(lines, 0)
    expect(r.warnings.join('\n')).toMatch(/heredoc.*unterminated|was never closed/)
  })

  it('preserves trailing whitespace on inline value lines', () => {
    const lines = blockLines('# @multipart-part name=x type=text', 'hello   ')
    const r = parseMultipartBlock(lines, 0)
    expect((r.parts[0] as { value: string }).value).toBe('hello   ')
  })

  it('supports multi-file under the same name', () => {
    const lines = blockLines(
      `# @multipart-part name=photo type=file file=${REF}`,
      `# @multipart-part name=photo type=file file=${'b'.repeat(64)}__other.jpg`
    )
    const r = parseMultipartBlock(lines, 0)
    expect(r.parts).toHaveLength(2)
    expect(r.parts.every((p) => p.name === 'photo')).toBe(true)
  })

  it('emits deterministic mp-<idx> ids', () => {
    const lines = blockLines(
      '# @multipart-part name=a type=text',
      'A',
      '# @multipart-part name=b type=text',
      'B'
    )
    const r = parseMultipartBlock(lines, 0)
    expect(r.parts.map((p) => p.id)).toEqual(['mp-0', 'mp-1'])
  })
})

describe('skipPreviewBlock', () => {
  it('returns the index after # @multipart-preview end and ignores content (CA-15)', () => {
    const lines = [
      '# @multipart-preview begin',
      '# Auto-generated text',
      'Content-Type: multipart/form-data; boundary=<generated-at-send>',
      '',
      '--<boundary>',
      'Content-Disposition: form-data; name="x"',
      '',
      'value',
      '--<boundary>--',
      '# @multipart-preview end',
      'AFTER'
    ]
    const r = skipPreviewBlock(lines, 0)
    expect(r.endIdx).toBe(10)
    expect(lines[r.endIdx]).toBe('AFTER')
    expect(r.warnings).toEqual([])
  })

  it('does nothing when not on a preview begin marker', () => {
    const lines = ['something else']
    const r = skipPreviewBlock(lines, 0)
    expect(r.endIdx).toBe(0)
  })

  it('warns when the preview block is unterminated', () => {
    const lines = ['# @multipart-preview begin', 'line', 'line']
    const r = skipPreviewBlock(lines, 0)
    expect(r.endIdx).toBe(3)
    expect(r.warnings.join('\n')).toMatch(/missing closing # @multipart-preview end/)
  })
})
