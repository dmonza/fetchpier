// Read entries from `<workspace>/requests/.runs/` for e2e assertions.
//
// REQ-0068 changed the on-disk format from one JSON-per-send to one
// `.http`-per-send. This helper exposes the projection the binary-body
// specs use (request method/url + response status/body, plus optional
// script-results for sandbox specs), reconstructed from the `.http` text.
//
// We deliberately do **not** import `@fetchpier/core/activity-log` here —
// the e2e tsconfig doesn't carry the sub-path mapping, and the on-disk
// format is small enough that a self-contained extractor keeps the test
// surface independent of how the core packages its parser.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'

const RESPONSE_SEPARATOR = '### Response'

export interface HistoryRunRequest {
  method: string
  url: string
  headers: Record<string, string>
  body?: string
}

export interface HistoryRunResponse {
  status: number
  statusText: string
  headers: Record<string, string>
  body: string
}

export interface HistoryRunScriptResult {
  success: boolean
  error?: { message?: string; stack?: string }
}

export interface HistoryRunEntry {
  id: string
  timestamp: string
  requestId?: string
  sourceFile: string | null
  request: HistoryRunRequest
  response: HistoryRunResponse
  scriptResults?: {
    preRequest?: HistoryRunScriptResult
    postResponse?: HistoryRunScriptResult
  }
}

function parseHeaderDirectives(lines: string[]): {
  directives: Record<string, string>
  next: number
} {
  const directives: Record<string, string> = {}
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (line === '') {
      i++
      continue
    }
    if (!line.startsWith('#')) break
    const m = line.match(/^# @([A-Za-z][A-Za-z0-9_-]*)(?::\s?(.*))?$/)
    if (m) directives[m[1]!] = m[2] ?? ''
    i++
  }
  // Skip blocks (`# @<name>` … `# @end-<name>`) — preview helpers don't need them.
  // Just skip until first non-# non-blank line.
  while (i < lines.length) {
    const line = lines[i]!
    if (line === '' || line.startsWith('#')) {
      i++
      continue
    }
    break
  }
  return { directives, next: i }
}

function parseHttpMessage(
  lines: string[],
  from: number,
  to: number
): {
  firstLine: string
  headers: Record<string, string>
  body: string
} {
  const firstLine = lines[from] ?? ''
  let i = from + 1
  const headers: Record<string, string> = {}
  for (; i < to; i++) {
    const line = lines[i]!
    if (line === '') {
      i++
      break
    }
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const k = line.slice(0, colon).trim()
    let v = line.slice(colon + 1)
    if (v.startsWith(' ')) v = v.slice(1)
    headers[k] = v
  }
  const bodyLines = lines.slice(i, to)
  let body = bodyLines.join('\n')
  // Strip the single trailing newline that the on-disk format ends on.
  if (body.endsWith('\n')) body = body.slice(0, -1)
  return { firstLine, headers, body }
}

function parseScriptResultsBlock(lines: string[]): HistoryRunScriptResult {
  let error: { message?: string; stack?: string } | undefined
  const stackFrames: string[] = []
  let failed = 0
  for (const line of lines) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const tag = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).replace(/^ /, '')
    if (tag === 'error') error = { message: value }
    else if (tag === 'stack') stackFrames.push(`    at ${value}`)
    else if (tag === 'fail') failed++
  }
  if (error && stackFrames.length > 0) {
    error = { ...error, stack: `Error: ${error.message}\n${stackFrames.join('\n')}` }
  }
  return { success: !error && failed === 0, error }
}

function extractTailBlock(text: string, blockName: string): string[] | undefined {
  const startMarker = `# @${blockName}`
  const endHead = blockName.split(':')[0]!.trim()
  const endMarker = `# @end-${endHead}`
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== startMarker) continue
    const out: string[] = []
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j] === endMarker) return out
      const inner = lines[j]!
      if (inner.startsWith('# ')) out.push(inner.slice(2))
      else if (inner === '#') out.push('')
    }
  }
  return undefined
}

function parseActivityLogEntry(text: string): HistoryRunEntry | null {
  const normalized = text.replace(/\r\n/g, '\n')
  const stripped = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized
  const lines = stripped.split('\n')

  const respIdx = lines.findIndex((l) => l === RESPONSE_SEPARATOR)
  if (respIdx < 0) return null

  const { directives, next: requestStart } = parseHeaderDirectives(lines)
  // Walk back from `### Response` past the blank separator.
  let reqEnd = respIdx
  if (reqEnd > requestStart && lines[reqEnd - 1] === '') reqEnd -= 1
  const reqMsg = parseHttpMessage(lines, requestStart, reqEnd)
  const requestLineMatch = reqMsg.firstLine.match(/^([A-Za-z]+)\s+(\S+)/)
  const method = requestLineMatch ? requestLineMatch[1]!.toUpperCase() : ''
  const url = directives['path-raw'] ?? (requestLineMatch ? requestLineMatch[2]! : '')

  let afterResp = respIdx + 1
  if (lines[afterResp] === '') afterResp += 1

  // Locate first tail block (if any) to bound the response.
  let tailStart = lines.length
  for (let i = afterResp; i < lines.length; i++) {
    const line = lines[i]!
    if (!line.startsWith('# @')) continue
    const head = line.slice(3).split(/[:\s]/)[0]
    if (!head || head.startsWith('end-')) continue
    // Confirm there's a matching end marker further down (it's a block, not a directive).
    const endMarker = `# @end-${head}`
    let hasEnd = false
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j] === endMarker) {
        hasEnd = true
        break
      }
    }
    if (hasEnd) {
      tailStart = i
      break
    }
  }
  let respLineEnd = tailStart
  if (tailStart < lines.length && respLineEnd > afterResp && lines[respLineEnd - 1] === '') {
    respLineEnd -= 1
  }
  const respMsg = parseHttpMessage(lines, afterResp, respLineEnd)
  const statusMatch = respMsg.firstLine.match(/^HTTP\/\S+\s+(\d{3})(?:\s+(.*))?$/)
  const status = statusMatch ? Number(statusMatch[1]) : 0
  const statusText = statusMatch ? (statusMatch[2] ?? '').trim() : ''

  const preLines = extractTailBlock(text, 'script-results: pre-request')
  const postLines = extractTailBlock(text, 'script-results: post-response')

  return {
    id: directives['run-id'] ?? '',
    timestamp: directives['timestamp'] ?? '',
    requestId: directives['request-id'],
    sourceFile: directives['source-file'] ?? null,
    request: {
      method,
      url,
      headers: reqMsg.headers,
      body: reqMsg.body || undefined
    },
    response: {
      status,
      statusText,
      headers: respMsg.headers,
      body: respMsg.body
    },
    scriptResults:
      preLines || postLines
        ? {
            preRequest: preLines ? parseScriptResultsBlock(preLines) : undefined,
            postResponse: postLines ? parseScriptResultsBlock(postLines) : undefined
          }
        : undefined
  }
}

/**
 * Read all `.http` entries under `<workspace>/requests/.runs/`, sorted by
 * timestamp ascending. Returns an empty array if the directory is missing.
 */
export async function readHistoryRuns(workspacePath: string): Promise<HistoryRunEntry[]> {
  const dir = join(workspacePath, 'requests', '.runs')
  const files = await fs.readdir(dir).catch(() => [] as string[])
  const out: HistoryRunEntry[] = []
  for (const f of files) {
    if (!f.endsWith('.http')) continue
    try {
      const raw = await fs.readFile(join(dir, f), 'utf-8')
      const entry = parseActivityLogEntry(raw)
      if (entry) out.push(entry)
    } catch {
      // Partially-written file at the moment we read — skip.
    }
  }
  return out.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
}

/** Convenience: latest entry by timestamp, or `null` when the directory is empty. */
export async function readLatestHistoryRun(workspacePath: string): Promise<HistoryRunEntry | null> {
  const entries = await readHistoryRuns(workspacePath)
  return entries.length > 0 ? entries[entries.length - 1]! : null
}
