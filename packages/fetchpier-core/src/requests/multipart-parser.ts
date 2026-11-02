import type { MultipartFilePart, MultipartPart, MultipartTextPart } from '@shared/types'
import { lookupMimeType } from './binary-store'

/**
 * Parser helpers for the `# @multipart begin/end` block (REQ-0066). These are
 * pure functions invoked from `parser.ts` when the body-section state machine
 * encounters `# @multipart begin` immediately after the headers blank line.
 *
 * Design notes:
 *   - The non-authoritative `# @multipart-preview begin/end` block is *opaque*:
 *     `skipPreviewBlock` drains every line between the markers without
 *     parsing them. The markers are the sole source of truth (REQ §5.2 rule
 *     10) and the preview is regenerated on every save (REQ §6.13).
 *   - Per-part validation failures (missing required attrs, conflicting
 *     attrs, malformed file-ref) follow REQ §5.2 rule 8: emit a warning and
 *     load the part as `disabled=true` with `parseError` set, so the user
 *     can fix it in the UI without losing data on the next save.
 *   - The part id (`MultipartPart.id`) is a local UI id and is not persisted;
 *     the parser assigns deterministic `mp-<idx>` ids for stable round-trip.
 */

const FILE_REF_PATTERN = /^[a-f0-9]{64}__.+$/

export const MULTIPART_BEGIN_MARKER = /^\s*#\s*@multipart\s+begin\s*$/
export const MULTIPART_END_MARKER = /^\s*#\s*@multipart\s+end\s*$/
export const MULTIPART_PART_MARKER = /^\s*#\s*@multipart-part\b(.*)$/
export const MULTIPART_PREVIEW_BEGIN_MARKER = /^\s*#\s*@multipart-preview\s+begin\s*$/
export const MULTIPART_PREVIEW_END_MARKER = /^\s*#\s*@multipart-preview\s+end\s*$/

interface ParsedAttribute {
  key: string
  value: string
  /** True when the value used the quoted-string form (for round-trip preservation). */
  quoted: boolean
}

/**
 * Tokenize the attribute list portion of a `# @multipart-part` marker line.
 * Recognises `key="quoted value"` and `key=unquoted_token`; whitespace
 * separates pairs. Quoted strings support `\"` and `\\` escapes. Unknown
 * shapes are caller-validated.
 */
export function parsePartAttributeList(input: string): ParsedAttribute[] {
  const out: ParsedAttribute[] = []
  let i = 0
  const n = input.length

  while (i < n) {
    while (i < n && /\s/.test(input[i])) i += 1
    if (i >= n) break

    const keyStart = i
    while (i < n && input[i] !== '=' && !/\s/.test(input[i])) i += 1
    const key = input.slice(keyStart, i)
    if (key.length === 0) {
      // Stray = without a preceding key: skip to next whitespace.
      while (i < n && !/\s/.test(input[i])) i += 1
      continue
    }
    if (i >= n || input[i] !== '=') {
      // Lone token with no `=`: record as flagless attribute. Caller treats
      // it as unknown and warns.
      out.push({ key, value: '', quoted: false })
      continue
    }
    i += 1 // consume '='

    if (i < n && input[i] === '"') {
      // Quoted string.
      i += 1
      let buf = ''
      while (i < n && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < n) {
          buf += input[i + 1]
          i += 2
        } else {
          buf += input[i]
          i += 1
        }
      }
      if (i < n) i += 1 // consume closing "
      out.push({ key, value: buf, quoted: true })
    } else {
      const vStart = i
      while (i < n && !/\s/.test(input[i])) i += 1
      out.push({ key, value: input.slice(vStart, i), quoted: false })
    }
  }
  return out
}

/**
 * Recognise a heredoc opener `<<<DELIM` on a line. Returns the delimiter (or
 * null if the line is not a heredoc opener). Empty / whitespace-containing
 * delimiters are rejected and treated as no-heredoc (caller warns).
 */
export function parseHeredocOpener(line: string): { delimiter: string } | null {
  const m = line.match(/^<<<(\S+)\s*$/)
  if (!m) return null
  const delim = m[1]
  if (delim.length === 0 || /\s/.test(delim)) return null
  return { delimiter: delim }
}

interface PartParseContext {
  /** Per-block warning sink. */
  warnings: string[]
  /** Per-block part counter (used to assign deterministic ids). */
  partCounter: { value: number }
}

/**
 * Determine the extent of a single part's value region starting at `valueIdx`
 * (the line immediately after the `# @multipart-part` marker). Heredocs take
 * precedence when the first non-blank line is `<<<DELIM`; otherwise the value
 * is the run of lines up to but not including the next part marker / end
 * marker, with leading and trailing blank lines trimmed.
 *
 * Returns the parsed value and the index of the next part marker / end marker.
 */
function extractValueRegion(
  lines: string[],
  valueIdx: number,
  warnings: string[]
): { value: string; nextIdx: number } {
  let scan = valueIdx
  while (scan < lines.length && lines[scan].trim() === '') scan += 1
  if (scan < lines.length) {
    const opener = parseHeredocOpener(lines[scan])
    if (opener) {
      const bodyStart = scan + 1
      let bodyEnd = bodyStart
      while (bodyEnd < lines.length && lines[bodyEnd] !== opener.delimiter) bodyEnd += 1
      if (bodyEnd >= lines.length) {
        warnings.push(
          `Multipart text part: heredoc opened with <<<${opener.delimiter} was never closed; treating remaining lines as value.`
        )
        return { value: lines.slice(bodyStart).join('\n'), nextIdx: lines.length }
      }
      const value = lines.slice(bodyStart, bodyEnd).join('\n')
      let after = bodyEnd + 1
      while (
        after < lines.length &&
        !MULTIPART_PART_MARKER.test(lines[after]) &&
        !MULTIPART_END_MARKER.test(lines[after])
      ) {
        if (lines[after].trim() !== '') {
          warnings.push(
            `Multipart block: stray content after heredoc closer — ignored: ${lines[after]}`
          )
        }
        after += 1
      }
      return { value, nextIdx: after }
    }
  }

  let end = valueIdx
  while (
    end < lines.length &&
    !MULTIPART_PART_MARKER.test(lines[end]) &&
    !MULTIPART_END_MARKER.test(lines[end])
  ) {
    end += 1
  }
  let trimmedEnd = end
  while (trimmedEnd > valueIdx && lines[trimmedEnd - 1].trim() === '') trimmedEnd -= 1
  let start = valueIdx
  while (start < trimmedEnd && lines[start].trim() === '') start += 1
  const value = start < trimmedEnd ? lines.slice(start, trimmedEnd).join('\n') : ''
  return { value, nextIdx: end }
}

/**
 * Build one part from the parsed attributes. Per-part validation failures set
 * `disabled=true` and populate `parseError` per REQ §5.2 rule 8 — the part
 * round-trips faithfully without sending. Unknown attributes warn and are
 * skipped. Variable references inside `file=` are rejected (REQ §6.5):
 * `fileRef` is the file's identity, not a value field.
 */
function buildPart(
  attrs: ParsedAttribute[],
  textValue: string,
  ctx: PartParseContext
): MultipartPart {
  const id = `mp-${ctx.partCounter.value++}`

  let name: string | undefined
  let type: 'text' | 'file' | undefined
  let contentType: string | undefined
  let filename: string | undefined
  let fileRef: string | undefined
  let disabled = false
  const seenUnknown: string[] = []

  for (const attr of attrs) {
    switch (attr.key) {
      case 'name':
        name = attr.value
        break
      case 'type':
        if (attr.value === 'text' || attr.value === 'file') type = attr.value
        else seenUnknown.push(`type=${attr.value}`)
        break
      case 'content-type':
        contentType = attr.value
        break
      case 'filename':
        filename = attr.value
        break
      case 'file':
        fileRef = attr.value
        break
      case 'disabled':
        if (attr.value === 'true') disabled = true
        break
      default:
        seenUnknown.push(attr.key)
    }
  }

  for (const u of seenUnknown) {
    ctx.warnings.push(`Multipart part: unknown attribute "${u}" — skipped.`)
  }

  // Validation. On failure we still build the part so the .http file
  // round-trips; we just mark it disabled with a parseError annotation.
  const errors: string[] = []
  if (name === undefined) errors.push('missing required attribute "name"')
  if (type === undefined) errors.push('missing or invalid required attribute "type"')

  if (type === 'text') {
    if (fileRef !== undefined) errors.push('text part cannot have "file" attribute')
    if (filename !== undefined) errors.push('text part cannot have "filename" attribute')
  } else if (type === 'file') {
    if (fileRef === undefined) {
      errors.push('file part missing required attribute "file"')
    } else {
      if (fileRef.includes('{{')) {
        errors.push(
          'MULTIPART_INVALID_PART: variable interpolation inside file=<ref> is not allowed'
        )
      } else if (!FILE_REF_PATTERN.test(fileRef)) {
        errors.push(
          `MULTIPART_INVALID_PART: invalid file ref "${fileRef}" (expected <64-hex>__<name>)`
        )
      }
    }
  }

  if (errors.length > 0) {
    for (const e of errors) {
      ctx.warnings.push(`Multipart part "${name ?? '(no name)'}": ${e}`)
    }
    disabled = true
  }

  // Disable annotation: when the part is invalid OR the type is unknown, we
  // surface as a file part if a fileRef-looking value was supplied, else a
  // text part — preserving as much metadata as possible.
  if (type === 'file' && fileRef !== undefined && FILE_REF_PATTERN.test(fileRef)) {
    const originalName = fileRef.slice(66)
    const filePart: MultipartFilePart = {
      kind: 'file',
      id,
      name: name ?? '',
      file: {
        ref: fileRef,
        originalName,
        sizeBytes: 0,
        mimeType: lookupMimeType(originalName)
      },
      filename,
      contentType,
      disabled: disabled || undefined,
      parseError: errors.length > 0 ? errors.join('; ') : undefined
    }
    return filePart
  }

  // Fall back to text part shape so the data survives a round-trip even when
  // the part was malformed (file= without a valid ref, etc.).
  const textPart: MultipartTextPart = {
    kind: 'text',
    id,
    name: name ?? '',
    value: textValue,
    contentType,
    disabled: disabled || undefined
  }
  // We carry the parseError on text parts via the warnings sink; only file
  // parts expose `parseError` in the type. This keeps the text union shape
  // narrow.
  return textPart
}

export interface MultipartParseResult {
  parts: MultipartPart[]
  /** Line index AFTER the `# @multipart end` marker. */
  endIdx: number
  /** Warnings to log; never fatal. */
  warnings: string[]
}

/**
 * Parse a `# @multipart begin … # @multipart end` block starting at line
 * `startIdx` (which must point at the `# @multipart begin` marker). Returns
 * the parts, the line index immediately after `# @multipart end`, and any
 * warnings emitted along the way. If the block is unterminated, returns
 * everything parsed so far and warns.
 */
export function parseMultipartBlock(lines: string[], startIdx: number): MultipartParseResult {
  const warnings: string[] = []
  const partCounter = { value: 0 }
  const parts: MultipartPart[] = []

  if (!MULTIPART_BEGIN_MARKER.test(lines[startIdx])) {
    warnings.push('parseMultipartBlock called on a line that is not # @multipart begin')
    return { parts, endIdx: startIdx, warnings }
  }

  let i = startIdx + 1

  // Skip stray content between `# @multipart begin` and the first part marker.
  while (
    i < lines.length &&
    !MULTIPART_PART_MARKER.test(lines[i]) &&
    !MULTIPART_END_MARKER.test(lines[i])
  ) {
    if (lines[i].trim() !== '') {
      warnings.push(
        `Multipart block: stray content before first # @multipart-part marker — ignored: ${lines[i]}`
      )
    }
    i += 1
  }

  while (i < lines.length) {
    if (MULTIPART_END_MARKER.test(lines[i])) {
      return { parts, endIdx: i + 1, warnings }
    }
    const markerMatch = MULTIPART_PART_MARKER.exec(lines[i])
    if (!markerMatch) {
      // Defensive: the skip-loop above should have placed us on a marker
      // or end-marker. Anything else is an unexpected stray line.
      warnings.push(`Multipart block: unexpected line "${lines[i]}" — ignored`)
      i += 1
      continue
    }
    const attrs = parsePartAttributeList(markerMatch[1] ?? '')
    const { value, nextIdx } = extractValueRegion(lines, i + 1, warnings)
    parts.push(buildPart(attrs, value, { warnings, partCounter }))
    i = nextIdx
  }

  warnings.push('Multipart block: missing closing # @multipart end marker.')
  return { parts, endIdx: lines.length, warnings }
}

/**
 * Drain a `# @multipart-preview begin … # @multipart-preview end` block
 * starting at `startIdx` (which must point at the begin marker). Returns the
 * line index immediately after the end marker. Per REQ §6.13 the preview is
 * non-authoritative and the parser must treat its content as opaque — no
 * validation, no warnings about the contents themselves. If the end marker
 * is missing, drain to EOF and warn.
 */
export function skipPreviewBlock(
  lines: string[],
  startIdx: number
): { endIdx: number; warnings: string[] } {
  if (!MULTIPART_PREVIEW_BEGIN_MARKER.test(lines[startIdx])) {
    return { endIdx: startIdx, warnings: [] }
  }
  let i = startIdx + 1
  while (i < lines.length && !MULTIPART_PREVIEW_END_MARKER.test(lines[i])) i += 1
  if (i >= lines.length) {
    return {
      endIdx: lines.length,
      warnings: ['Multipart preview block: missing closing # @multipart-preview end marker.']
    }
  }
  return { endIdx: i + 1, warnings: [] }
}
