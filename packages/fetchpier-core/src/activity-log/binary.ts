// Binary body detection + placeholder formatting (neutral).
//
// REQ-0068 §5.2.3: a body is rendered as a placeholder line — instead of the
// raw bytes — when **any** of the following hold (evaluated in this order):
//
//   1. Content-Type matches a closed list of binary prefixes.
//   2. Content-Encoding is present and ≠ `identity`.
//   3. The first 1 KB of the body does not decode as valid UTF-8.

import type { BinaryDecision } from './types'

const BINARY_CONTENT_TYPES_EXACT: readonly string[] = [
  'application/octet-stream',
  'application/pdf',
  'application/zip',
  'application/gzip',
  'application/x-tar',
  'application/wasm',
  'application/x-protobuf'
]

const BINARY_CONTENT_TYPE_PREFIXES: readonly string[] = ['image/', 'video/', 'audio/', 'font/']

const PROBE_BYTES = 1024

function headerLookup(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  const target = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) {
      const v = headers[key]
      if (Array.isArray(v)) return v[0]
      return v
    }
  }
  return undefined
}

function normalizeContentType(ct: string | undefined): string {
  if (!ct) return ''
  // strip parameters (`; charset=utf-8`) and lowercase
  const semi = ct.indexOf(';')
  const head = semi >= 0 ? ct.slice(0, semi) : ct
  return head.trim().toLowerCase()
}

function matchesBinaryContentType(ct: string): boolean {
  if (!ct) return false
  if (BINARY_CONTENT_TYPES_EXACT.includes(ct)) return true
  return BINARY_CONTENT_TYPE_PREFIXES.some((p) => ct.startsWith(p))
}

function isProbablyUtf8(bytes: Uint8Array): boolean {
  let i = 0
  const n = Math.min(bytes.length, PROBE_BYTES)
  while (i < n) {
    const b = bytes[i]!
    // ASCII fast path; the C0 control range is allowed (HTTP bodies have
    // newlines, tabs, etc.). NUL is suspicious but technically valid UTF-8 —
    // treat it as binary because it's a strong signal.
    if (b === 0x00) return false
    if (b < 0x80) {
      i++
      continue
    }
    // Multi-byte sequence — count the leading 1-bits.
    let extra: number
    if ((b & 0xe0) === 0xc0) extra = 1
    else if ((b & 0xf0) === 0xe0) extra = 2
    else if ((b & 0xf8) === 0xf0) extra = 3
    else return false
    if (i + extra >= n) {
      // Truncated multi-byte sequence at the end of the probe window. Be
      // lenient: trailing partial sequences are valid UTF-8 in the full
      // stream, just not within our 1 KB window.
      return true
    }
    for (let j = 1; j <= extra; j++) {
      const c = bytes[i + j]!
      if ((c & 0xc0) !== 0x80) return false
    }
    i += extra + 1
  }
  return true
}

function bodyToBytes(body: string | Uint8Array): Uint8Array {
  if (typeof body !== 'string') return body
  // We only need the first PROBE_BYTES bytes — encode the equivalent slice.
  // In practice the body string is rarely huge here, so encoding all of it is
  // fine, but cap to avoid pathologic cases.
  const slice = body.length > PROBE_BYTES * 4 ? body.slice(0, PROBE_BYTES * 4) : body
  return new TextEncoder().encode(slice)
}

/**
 * Decide whether a body should be rendered as a binary placeholder.
 *
 * `body` accepts `string` (most common in our pipeline — the HTTP client
 * decodes textual responses) or `Uint8Array` (for raw bytes). When both
 * `contentType` and `contentEncoding` arguments are passed explicitly, they
 * win over whatever lookups would do — useful for testing.
 */
export function detectBinaryBody(args: {
  headers?: Record<string, string | string[] | undefined>
  body?: string | Uint8Array | null
  contentType?: string
  contentEncoding?: string
}): BinaryDecision {
  const ct = normalizeContentType(
    args.contentType ?? headerLookup(args.headers ?? {}, 'content-type')
  )
  if (matchesBinaryContentType(ct)) return { isBinary: true, reason: 'content-type' }

  const ce = (args.contentEncoding ?? headerLookup(args.headers ?? {}, 'content-encoding') ?? '')
    .trim()
    .toLowerCase()
  if (ce && ce !== 'identity') return { isBinary: true, reason: 'content-encoding' }

  if (args.body != null) {
    const bytes = bodyToBytes(args.body)
    if (!isProbablyUtf8(bytes)) return { isBinary: true, reason: 'utf8-probe' }
  }

  return { isBinary: false }
}

/** Compute the size in bytes of a body (string is measured as UTF-8). */
export function bodyByteLength(body: string | Uint8Array | null | undefined): number {
  if (body == null) return 0
  if (typeof body === 'string') return new TextEncoder().encode(body).length
  return body.byteLength
}

/**
 * Render the placeholder line that replaces a binary body in the `.http`.
 *
 * Format: `[binary body, <N> bytes, content-type: <ct>, content-encoding: <ce>]`
 * — `content-encoding` is omitted when not set.
 */
export function binaryPlaceholder(args: {
  byteLength: number
  contentType?: string
  contentEncoding?: string
}): string {
  const ct = (args.contentType ?? '').trim() || 'application/octet-stream'
  const ce = (args.contentEncoding ?? '').trim()
  const parts = [`binary body`, `${args.byteLength} bytes`, `content-type: ${ct}`]
  if (ce) parts.push(`content-encoding: ${ce}`)
  return `[${parts.join(', ')}]`
}
