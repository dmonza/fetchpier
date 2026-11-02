// Header-only reader for the activity-log list view (REQ-0068 §5.5 + A6).
//
// `history.list()` needs enough metadata per file to render a row — directives
// + request method/URL + response status — without loading bodies or script
// blocks. This reader scans line-by-line and stops as soon as it has the
// response status line. Tail blocks, response headers, response body and
// request body are never inspected.
//
// The full text is still passed in (the caller reads the file); the win is
// avoiding `parseActivityLog`'s body string allocations and tail-block
// traversal on every list refresh.

import { RESPONSE_SEPARATOR } from './serializer'

const DIRECTIVE_OR_BLOCK_RE = /^# @([A-Za-z][A-Za-z0-9_-]*)(.*)$/

export interface ActivityLogMetadataPreview {
  /** Map of directive key → value (last one wins for duplicates). */
  directives: Record<string, string>
  /** Header blocks (e.g. `# @settings` … `# @end-settings`). */
  blocks: Array<{ name: string; lines: string[] }>
  /** Request method (uppercase) + raw URL as written on the request-line. `null` if not present. */
  requestLine: { method: string; url: string } | null
  /** Response status code + reason phrase. `null` if not present. */
  responseStatus: { code: number; statusText: string } | null
}

function parseStatusLine(line: string): { code: number; statusText: string } | null {
  // `HTTP/1.1 200 OK` — version, code, optional reason.
  const m = line.match(/^HTTP\/\S+\s+(\d{3})(?:\s+(.*))?$/)
  if (!m) return null
  return { code: Number(m[1]), statusText: (m[2] ?? '').trim() }
}

function parseRequestLine(line: string): { method: string; url: string } | null {
  // `METHOD URL HTTP/1.1` — method, URL, version.
  const m = line.match(/^([A-Za-z]+)\s+(\S+)(?:\s+HTTP\/\S+)?$/)
  if (!m) return null
  return { method: m[1]!.toUpperCase(), url: m[2]! }
}

/**
 * Extract just the metadata preview from an activity-log `.http` text.
 *
 * Bounded work — stops after the response status line. Never reads bodies or
 * tail blocks. Robust to malformed input: returns nulls for missing pieces
 * instead of throwing.
 */
export function readMetadataPreview(text: string): ActivityLogMetadataPreview {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const stripped = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized
  const lines = stripped.split('\n')

  const preview: ActivityLogMetadataPreview = {
    directives: {},
    blocks: [],
    requestLine: null,
    responseStatus: null
  }

  let i = 0

  // 1. Header (directives + blocks + free comments + blanks).
  while (i < lines.length) {
    const line = lines[i]!
    if (line === '') {
      i++
      continue
    }
    if (!line.startsWith('#')) break
    const m = line.match(DIRECTIVE_OR_BLOCK_RE)
    if (m) {
      const head = m[1]!
      const rest = m[2]!
      if (!head.startsWith('end-')) {
        // Look ahead for `# @end-<head>` within the header scope (up to the
        // first non-# non-blank line OR `### Response`, whichever first).
        let scopeEnd = lines.length
        for (let k = i + 1; k < lines.length; k++) {
          const lk = lines[k]!
          if (lk === RESPONSE_SEPARATOR) {
            scopeEnd = k
            break
          }
          if (lk !== '' && !lk.startsWith('#')) {
            scopeEnd = k
            break
          }
        }
        const endMarker = `# @end-${head}`
        let endIdx = -1
        for (let k = i + 1; k < scopeEnd; k++) {
          if (lines[k] === endMarker) {
            endIdx = k
            break
          }
        }
        if (endIdx > 0) {
          const name = `${head}${rest}`.trim()
          const inner: string[] = []
          for (let k = i + 1; k < endIdx; k++) {
            const inn = lines[k]!
            if (inn.startsWith('# ')) inner.push(inn.slice(2))
            else if (inn === '#') inner.push('')
            // tolerate malformed inner — we're a preview, not a validator
          }
          preview.blocks.push({ name, lines: inner })
          i = endIdx + 1
          continue
        }
      }
      // Directive.
      const colonIdx = rest.indexOf(':')
      if (colonIdx === -1) {
        preview.directives[head] = ''
      } else {
        let value = rest.slice(colonIdx + 1)
        if (value.startsWith(' ')) value = value.slice(1)
        preview.directives[head] = value
      }
      i++
      continue
    }
    // Free-form comment — skip.
    i++
  }

  // 2. Request line.
  if (i < lines.length) {
    preview.requestLine = parseRequestLine(lines[i]!)
    i++
  }

  // 3. Skip request headers + body until we hit `### Response`.
  while (i < lines.length) {
    if (lines[i] === RESPONSE_SEPARATOR) {
      i++
      break
    }
    i++
  }

  // 4. Skip the blank line just after `### Response`.
  if (lines[i] === '') i++

  // 5. Read the status line and stop.
  if (i < lines.length) {
    preview.responseStatus = parseStatusLine(lines[i]!)
  }

  return preview
}
