// Activity-log parser (REQ-0068 §5.2 + §6.4).
//
// Input: the full UTF-8 text of an activity-log `.http` file.
// Output: an `ActivityLogFile` that, when fed to `serializeActivityLog`,
//         reproduces the input byte-for-byte (for canonical inputs).
//
// Round-trip invariant — section by section:
//   • Header: every `# @<key>: <value>`, free-form `#` comment, blank line,
//     and `# @<name>` ... `# @end-<head>` block survives. Unknown directives
//     and unknown blocks are preserved verbatim — this is what makes the
//     extension-by-domain model work (e.g. the requests-side parser tolerates
//     mock-side `# @route-id` without interpretation).
//   • Request raw / response raw: stored as opaque text between markers.
//   • Tail blocks: parsed the same way as header blocks.
//
// Canonical separators (one blank line each) are absorbed by the parser and
// re-added by the serializer: header→request, request→`### Response`,
// `### Response`→response, response→first tail block, tail block→next tail
// block. Inputs with the canonical layout round-trip byte-for-byte.

import { RESPONSE_SEPARATOR } from './serializer'
import type { ActivityLogFile, ExtensionBlock, HeaderItem } from './types'

const DIRECTIVE_OR_BLOCK_RE = /^# @([A-Za-z][A-Za-z0-9_-]*)(.*)$/

function findMatchingEnd(lines: string[], start: number, head: string, scopeEnd: number): number {
  const end = `# @end-${head}`
  for (let j = start; j < scopeEnd; j++) {
    if (lines[j] === end) return j
  }
  return -1
}

function findHeaderEnd(lines: string[]): number {
  for (let j = 0; j < lines.length; j++) {
    const l = lines[j]!
    if (l === '' || l.startsWith('#')) continue
    return j
  }
  return lines.length
}

function findResponseSeparator(lines: string[], from: number): number {
  for (let j = from; j < lines.length; j++) {
    if (lines[j] === RESPONSE_SEPARATOR) return j
  }
  return -1
}

function findFirstTailBlock(lines: string[], from: number, to: number): number {
  // A tail block start: a line `# @<name>` for which a matching
  // `# @end-<head>` exists later in [j+1, to). Once we find such a candidate,
  // everything from there is interpreted as tail blocks.
  for (let j = from; j < to; j++) {
    const m = lines[j]!.match(DIRECTIVE_OR_BLOCK_RE)
    if (!m) continue
    const head = m[1]!
    if (head.startsWith('end-')) continue // an orphan end marker is not a block start
    if (findMatchingEnd(lines, j + 1, head, to) > 0) return j
  }
  return -1
}

function parseBlockInner(lines: string[], start: number, endIdx: number, head: string): string[] {
  const inner: string[] = []
  for (let j = start; j < endIdx; j++) {
    const l = lines[j]!
    if (l.startsWith('# ')) inner.push(l.slice(2))
    else if (l === '#') inner.push('')
    else throw new Error(`activity-log parser: unexpected line inside block @${head}: "${l}"`)
  }
  return inner
}

function parseHeader(lines: string[], headerEnd: number): HeaderItem[] {
  const items: HeaderItem[] = []
  let i = 0
  while (i < headerEnd) {
    const line = lines[i]!
    if (line === '') {
      items.push({ kind: 'blank' })
      i++
      continue
    }
    const m = line.match(DIRECTIVE_OR_BLOCK_RE)
    if (m) {
      const head = m[1]!
      const rest = m[2]!
      if (!head.startsWith('end-')) {
        const endIdx = findMatchingEnd(lines, i + 1, head, headerEnd)
        if (endIdx > 0) {
          const name = `${head}${rest}`.trim()
          const innerLines = parseBlockInner(lines, i + 1, endIdx, head)
          items.push({ kind: 'block', name, lines: innerLines })
          i = endIdx + 1
          continue
        }
      }
      const colonIdx = rest.indexOf(':')
      if (colonIdx === -1) {
        items.push({ kind: 'directive', key: head, value: '' })
      } else {
        let value = rest.slice(colonIdx + 1)
        if (value.startsWith(' ')) value = value.slice(1)
        items.push({ kind: 'directive', key: head, value })
      }
      i++
      continue
    }
    // Any other `#`-prefixed line is a free-form comment.
    items.push({ kind: 'comment', text: line })
    i++
  }
  // The last blank in the header is the mandatory separator before the
  // request-line — drop it (re-emitted by the serializer).
  if (items.length > 0 && items[items.length - 1]!.kind === 'blank') {
    items.pop()
  }
  return items
}

function parseTailSection(lines: string[], from: number, end: number): ExtensionBlock[] {
  const blocks: ExtensionBlock[] = []
  let i = from
  while (i < end) {
    const line = lines[i]!
    if (line === '') {
      i++
      continue
    }
    const m = line.match(DIRECTIVE_OR_BLOCK_RE)
    if (!m) {
      throw new Error(`activity-log parser: unexpected line in tail section: "${line}"`)
    }
    const head = m[1]!
    const rest = m[2]!
    const endIdx = findMatchingEnd(lines, i + 1, head, end)
    if (endIdx < 0) {
      throw new Error(`activity-log parser: tail block "${head}" has no matching # @end-${head}`)
    }
    const name = `${head}${rest}`.trim()
    blocks.push({ name, lines: parseBlockInner(lines, i + 1, endIdx, head) })
    i = endIdx + 1
  }
  return blocks
}

/**
 * Parse an activity-log `.http` text into an `ActivityLogFile`.
 *
 * Throws on structural errors (missing `### Response`, dangling block-end,
 * malformed inner-block lines).
 */
export function parseActivityLog(text: string): ActivityLogFile {
  // Normalise line endings; we re-emit LF.
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const stripped = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized
  const lines = stripped.split('\n')

  // 1. Header.
  const headerEnd = findHeaderEnd(lines)
  const header = parseHeader(lines, headerEnd)

  // 2. Request raw — from headerEnd up to (and not including) the blank
  //    separator just before `### Response`.
  const respIdx = findResponseSeparator(lines, headerEnd)
  if (respIdx < 0) {
    throw new Error('activity-log parser: missing "### Response" separator')
  }
  let reqEnd = respIdx
  if (reqEnd > headerEnd && lines[reqEnd - 1] === '') reqEnd -= 1
  const requestRawLines = lines.slice(headerEnd, reqEnd)
  const requestRaw = requestRawLines.length > 0 ? requestRawLines.join('\n') + '\n' : ''

  // 3. Skip `### Response` plus one separator blank.
  let afterResp = respIdx + 1
  if (lines[afterResp] === '') afterResp += 1

  // 4. Tail blocks (if any) — locate the first one to bound the response.
  const tailStart = findFirstTailBlock(lines, afterResp, lines.length)
  let respLineEnd = tailStart >= 0 ? tailStart : lines.length
  if (tailStart >= 0 && respLineEnd > afterResp && lines[respLineEnd - 1] === '') respLineEnd -= 1
  const responseRawLines = lines.slice(afterResp, respLineEnd)
  const responseRaw = responseRawLines.length > 0 ? responseRawLines.join('\n') + '\n' : ''

  const tailBlocks = tailStart >= 0 ? parseTailSection(lines, tailStart, lines.length) : []

  return { header, requestRaw, responseRaw, tailBlocks }
}
