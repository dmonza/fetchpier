import type { MultipartPart } from '../types'

/**
 * Pure formatting helpers shared by the multipart encoder (in core) and the
 * `.http` serializer's wire-preview renderer. Moving the RFC 5987 / RFC 6266
 * logic here guarantees the on-disk preview and the actual wire output are
 * byte-identical for the same parts list.
 *
 * Lives under `src/shared/lib/` because both the renderer-facing serializer
 * (which sees no Node) and the core encoder (which reads files in Node) need
 * the same string formatting. Keep this file pure-string: no `Buffer`, no
 * filesystem, no environment.
 */

/** RFC 5987 attr-char set — every other byte must be percent-encoded. */
const ATTR_CHAR = /[A-Za-z0-9!#$&+\-.^_`|~]/

/**
 * Percent-encode a UTF-8 string per RFC 5987 attr-char rules. Used for the
 * `filename*=UTF-8''<value>` parameter when the wire-filename contains
 * non-ASCII characters or characters outside the attr-char set.
 */
export function percentEncodeRfc5987(input: string): string {
  // Use TextEncoder to avoid pulling in a Node Buffer in renderer code.
  const bytes = new TextEncoder().encode(input)
  let out = ''
  for (const b of bytes) {
    if (b < 128 && ATTR_CHAR.test(String.fromCharCode(b))) {
      out += String.fromCharCode(b)
    } else {
      out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`
    }
  }
  return out
}

/**
 * Deterministic ASCII transliteration: every non-ASCII code point becomes `?`.
 * Used to produce the RFC 6266 `filename=` ASCII fallback alongside
 * `filename*=UTF-8''…` for non-ASCII wire-filenames.
 */
export function asciiTransliterate(input: string): string {
  let out = ''
  for (const ch of input) {
    const cp = ch.codePointAt(0)!
    out += cp < 128 ? ch : '?'
  }
  return out
}

/**
 * Decide whether a wire-filename can be expressed as a plain
 * `filename="..."` parameter or whether it requires the
 * `filename*=UTF-8''…` RFC 5987 form. A plain form is acceptable only when
 * the value is pure US-ASCII and contains none of `"`, `\`, CR, LF, `%`.
 */
export function isAsciiSafeFilename(input: string): boolean {
  for (const ch of input) {
    const cp = ch.codePointAt(0)!
    if (cp > 127) return false
    if (ch === '"' || ch === '\\' || ch === '\r' || ch === '\n' || ch === '%') return false
  }
  return true
}

/**
 * Backslash-escape `"` and `\` in a quoted-string value (RFC 7230
 * quoted-string rules). CR/LF rejection is enforced upstream at validation
 * time, since they are invalid in a header line at all.
 */
export function escapeQuoted(input: string): string {
  return input.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Build the `Content-Disposition` header value for one part. Always emits
 * `form-data; name="..."`; for file parts also emits `filename` and (when
 * the wire-filename is non-ASCII or contains unsafe chars) `filename*=UTF-8''…`.
 *
 * Throws if the part name or filename contains CR/LF (which is invalid on
 * a header line). Callers in the encoder treat the throw as
 * `MULTIPART_INVALID_PART`; callers in the serializer treat it the same way.
 */
export function encodeContentDisposition(part: MultipartPart, wireFilename?: string): string {
  if (part.name.includes('\r') || part.name.includes('\n')) {
    throw new Error(`Multipart part name contains CR or LF: ${JSON.stringify(part.name)}`)
  }
  let header = `form-data; name="${escapeQuoted(part.name)}"`
  if (part.kind === 'file' && wireFilename !== undefined) {
    if (wireFilename.includes('\r') || wireFilename.includes('\n')) {
      throw new Error(`Multipart filename contains CR or LF: ${JSON.stringify(wireFilename)}`)
    }
    if (isAsciiSafeFilename(wireFilename)) {
      header += `; filename="${escapeQuoted(wireFilename)}"`
    } else {
      const fallback = escapeQuoted(asciiTransliterate(wireFilename))
      header += `; filename="${fallback}"; filename*=UTF-8''${percentEncodeRfc5987(wireFilename)}`
    }
  }
  return header
}

/** Resolve the wire-`filename` for a file part: explicit override → staged original. */
export function resolveWireFilename(part: MultipartPart & { kind: 'file' }): string {
  if (part.filename && part.filename.length > 0) return part.filename
  return part.file.originalName
}

/**
 * Resolve the wire-`Content-Type` for a single part. For file parts: explicit
 * override → staged mime → `application/octet-stream`. For text parts: only
 * the explicit override is emitted (absence means receivers default to
 * `text/plain;charset=US-ASCII` per RFC 7578 §4.4).
 */
export function resolvePartContentType(part: MultipartPart): string | undefined {
  if (part.kind === 'file') {
    if (part.contentType && part.contentType.trim()) return part.contentType.trim()
    if (part.file.mimeType && part.file.mimeType.trim()) return part.file.mimeType.trim()
    return 'application/octet-stream'
  }
  if (part.contentType && part.contentType.trim()) return part.contentType.trim()
  return undefined
}

/** Format a byte count as a stable, human-readable size for the wire-preview. */
export function humanReadableSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return `${bytes} B`
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/**
 * Unquoted-token character set for `.http` `# @multipart-part` attribute
 * values per REQ §5.2. Values matching this set are emitted bare; others are
 * quoted with `"..."` and `\"` / `\\` escapes.
 */
const UNQUOTED_TOKEN = /^[A-Za-z0-9._/+\-{}@*]+$/

/**
 * Serialise an attribute value for a `# @multipart-part` marker line.
 * Returns the bare token when safe, otherwise a quoted-string with `"` and
 * `\` escaped.
 */
export function serializeAttributeValue(value: string): string {
  if (value !== '' && UNQUOTED_TOKEN.test(value)) return value
  return `"${escapeQuoted(value)}"`
}
