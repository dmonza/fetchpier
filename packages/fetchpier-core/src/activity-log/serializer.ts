// Activity-log serializer (REQ-0068 §5.2).
//
// Takes an `ActivityLogFile` (parsed or programmatically built) and produces
// the canonical UTF-8 text. The reverse direction lives in `./parser.ts`.
//
// Layout:
//
//   <header items, one per line>
//   <blank>
//   <requestRaw — request-line + headers + blank + body>
//   <blank>
//   ### Response
//   <blank>
//   <responseRaw — status-line + headers + blank + body>
//   <blank>
//   <tail blocks: # @<name> / # <line>… / # @end-<name>, separated by blanks>
//
// Header items contain their own blank lines when relevant. We do not inject
// or de-duplicate blanks against what the caller stored, so a round-trip
// parse → serialize is byte-identical for well-formed input.

import type { ActivityLogFile, ExtensionBlock, HeaderItem } from './types'

const RESPONSE_SEPARATOR = '### Response'

/**
 * The end marker uses only the **kebab head** of the block name — e.g. for
 * `# @script-results: post-response`, the end marker is `# @end-script-results`
 * (not `# @end-script-results: post-response`). The subtype after `:` is
 * ornamental and only appears on the start line.
 */
function endHead(name: string): string {
  const colon = name.indexOf(':')
  return colon === -1 ? name : name.slice(0, colon).trim()
}

function emitHeaderItem(item: HeaderItem): string {
  switch (item.kind) {
    case 'directive':
      return `# @${item.key}: ${item.value}`
    case 'comment':
      return item.text
    case 'blank':
      return ''
    case 'block': {
      const lines = [`# @${item.name}`]
      for (const l of item.lines) lines.push(`# ${l}`)
      lines.push(`# @end-${endHead(item.name)}`)
      return lines.join('\n')
    }
  }
}

function emitTailBlock(block: ExtensionBlock): string {
  const lines = [`# @${block.name}`]
  for (const l of block.lines) lines.push(`# ${l}`)
  lines.push(`# @end-${endHead(block.name)}`)
  return lines.join('\n')
}

function stripTrailingNewline(s: string): string {
  // Normalize: caller may or may not include a trailing newline on the raw
  // sections. We strip it once and let the serializer add exactly one back at
  // section boundaries.
  if (s.endsWith('\n')) return s.slice(0, -1)
  return s
}

/**
 * Serialize an activity-log file to a UTF-8 string.
 *
 * The output ends with a trailing newline. Round-trip invariant with
 * `parseActivityLog`: `serialize(parse(text)) === text` for any text produced
 * by `serialize`.
 */
export function serializeActivityLog(file: ActivityLogFile): string {
  const parts: string[] = []

  // Header.
  for (const item of file.header) {
    parts.push(emitHeaderItem(item))
  }

  // Separator + request.
  parts.push('') // blank between header and request
  parts.push(stripTrailingNewline(file.requestRaw))

  // Separator + response.
  parts.push('') // blank before ### Response
  parts.push(RESPONSE_SEPARATOR)
  parts.push('') // blank between ### Response and status line
  parts.push(stripTrailingNewline(file.responseRaw))

  // Tail blocks.
  for (const block of file.tailBlocks) {
    parts.push('') // blank between sections
    parts.push(emitTailBlock(block))
  }

  return parts.join('\n') + '\n'
}

export { RESPONSE_SEPARATOR }
