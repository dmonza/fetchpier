// Renderer-safe access to the activity-log format (REQ-0068).
//
// The parser, serializer and types live in the pure `@fetchpier/core/activity-log`
// sub-entry — no Node imports, safe to bundle into the renderer via Vite.
// This wrapper also re-implements the `ActivityLogFile → HistoryEntry`
// rebuild used by the activity-panel viewers. The forward direction
// (`HistoryEntry → ActivityLogFile`) lives in the core (`workspace/history-format.ts`)
// because only the main process needs it (it runs at save time).
//
// Keeping the rebuild here — instead of in `@fetchpier/core` — avoids
// pulling `workspace/history-format.ts` into the renderer bundle. The
// rebuild is intentionally lossy: script-log timestamps are dropped, the
// `# @settings` block reduces to its seven scalar keys, and bodies arrive
// as plain text (binary bodies show the placeholder line as the body).

import {
  parseActivityLog as _parseActivityLog,
  type ActivityLogFile
} from '@fetchpier/core/activity-log'
import type {
  HistoryEntry,
  HttpRequest,
  HttpResponse,
  ScriptExecutionResult,
  ScriptLog,
  ScriptResultsBundle,
  ScriptTestResult,
  WorkspaceHttpSettings
} from '@shared/types'

export { parseActivityLog } from '@fetchpier/core/activity-log'
export type { ActivityLogFile, HeaderItem, ExtensionBlock } from '@fetchpier/core/activity-log'

// Mirrors the SETTINGS_KEYS array in `workspace/history-format.ts`. The two
// must stay in sync.
const SETTINGS_KEYS = [
  'verifySsl',
  'followRedirects',
  'maxRedirects',
  'followAuthorizationOnRedirect',
  'encodeUrl',
  'disableCookieJar',
  'httpVersion'
] as const

function findDirective(file: ActivityLogFile, key: string): string | undefined {
  for (const it of file.header) {
    if (it.kind === 'directive' && it.key === key) return it.value
  }
  return undefined
}

function findHeaderBlock(file: ActivityLogFile, name: string): string[] | undefined {
  for (const it of file.header) {
    if (it.kind === 'block' && it.name === name) return it.lines
  }
  return undefined
}

function findTailBlock(file: ActivityLogFile, fullName: string): string[] | undefined {
  for (const b of file.tailBlocks) {
    if (b.name === fullName) return b.lines
  }
  return undefined
}

function parseSettingsBlock(lines: string[]): WorkspaceHttpSettings | undefined {
  const out: Record<string, unknown> = {}
  for (const line of lines) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const k = line.slice(0, colon).trim()
    const vRaw = line.slice(colon + 1).trim()
    let v: unknown = vRaw
    if (vRaw === 'true') v = true
    else if (vRaw === 'false') v = false
    else if (/^-?\d+$/.test(vRaw)) v = Number(vRaw)
    out[k] = v
  }
  for (const k of SETTINGS_KEYS) if (k in out) return out as unknown as WorkspaceHttpSettings
  return undefined
}

function parseHttpMessage(raw: string): {
  firstLine: string
  headers: Record<string, string>
  body: string
} {
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n')
  const firstLine = lines[0] ?? ''
  let i = 1
  const headers: Record<string, string> = {}
  for (; i < lines.length; i++) {
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
  const bodyLines = lines.slice(i)
  let body = bodyLines.join('\n')
  if (body.endsWith('\n')) body = body.slice(0, -1)
  return { firstLine, headers, body }
}

const LOG_LEVELS = new Set<ScriptLog['level']>(['log', 'warn', 'error'])

/**
 * One entry from a `# @script-results: pre-request|post-response` block,
 * preserving the original emission order. Used by the run-detail viewer
 * (REQ-0069) to render logs and assertions interleaved as they occurred,
 * which `parseScriptResultLines` cannot do (it sorts them into separate
 * `logs[]` / `testResults[]` arrays).
 */
export type ScriptResultEntry =
  | { kind: 'log'; level: ScriptLog['level']; text: string }
  | { kind: 'test'; name: string; passed: true }
  | { kind: 'test'; name: string; passed: false; message?: string }
  | { kind: 'error'; message: string; stack?: string }

/**
 * Parse a `@script-results` block into a flat, ordered list of entries.
 * Classification matches `parseScriptResultLines`: a leading `error:` is the
 * top-level script error (not a log line at level=error). Subsequent `stack:`
 * lines accumulate into the last emitted error entry's `stack` field.
 */
export function parseScriptResultEntries(lines: string[]): ScriptResultEntry[] {
  const entries: ScriptResultEntry[] = []
  const stackFramesByErrorIdx = new Map<number, string[]>()
  let lastErrorIdx = -1
  for (const line of lines) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const tag = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).replace(/^ /, '')
    if (tag === 'pass') {
      entries.push({ kind: 'test', name: value, passed: true })
    } else if (tag === 'fail') {
      const sep = value.indexOf(' — ')
      if (sep >= 0) {
        entries.push({
          kind: 'test',
          name: value.slice(0, sep),
          passed: false,
          message: value.slice(sep + 3)
        })
      } else {
        entries.push({ kind: 'test', name: value, passed: false })
      }
    } else if (tag === 'error') {
      lastErrorIdx = entries.length
      entries.push({ kind: 'error', message: value })
    } else if (tag === 'stack') {
      if (lastErrorIdx >= 0) {
        const frames = stackFramesByErrorIdx.get(lastErrorIdx) ?? []
        frames.push(`    at ${value}`)
        stackFramesByErrorIdx.set(lastErrorIdx, frames)
      }
    } else if (LOG_LEVELS.has(tag as ScriptLog['level'])) {
      entries.push({ kind: 'log', level: tag as ScriptLog['level'], text: value })
    } else {
      entries.push({ kind: 'log', level: 'log', text: `[${tag}] ${value}` })
    }
  }
  for (const [idx, frames] of stackFramesByErrorIdx) {
    const e = entries[idx]
    if (e && e.kind === 'error') {
      e.stack = `Error: ${e.message}\n${frames.join('\n')}`
    }
  }
  return entries
}

function parseScriptResultLines(lines: string[]): ScriptExecutionResult {
  const logs: ScriptLog[] = []
  const testResults: ScriptTestResult[] = []
  let error: { message: string; stack?: string } | undefined
  const stackFrames: string[] = []
  for (const line of lines) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const tag = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).replace(/^ /, '')
    if (tag === 'pass') {
      testResults.push({ name: value, passed: true })
    } else if (tag === 'fail') {
      const sep = value.indexOf(' — ')
      if (sep >= 0) {
        testResults.push({ name: value.slice(0, sep), passed: false, error: value.slice(sep + 3) })
      } else {
        testResults.push({ name: value, passed: false })
      }
    } else if (tag === 'error') {
      error = { message: value }
    } else if (tag === 'stack') {
      stackFrames.push(`    at ${value}`)
    } else if (LOG_LEVELS.has(tag as ScriptLog['level'])) {
      logs.push({ level: tag as ScriptLog['level'], args: [value], timestamp: '' })
    } else {
      logs.push({ level: 'log', args: [`[${tag}] ${value}`], timestamp: '' })
    }
  }
  if (error && stackFrames.length > 0) {
    error = { ...error, stack: `Error: ${error.message}\n${stackFrames.join('\n')}` }
  }
  const failed = testResults.filter((t) => !t.passed).length
  return {
    success: !error && failed === 0,
    error,
    logs,
    testResults
  }
}

/**
 * Reconstruct a `HistoryEntry` from a parsed `ActivityLogFile`. Lossy —
 * script log timestamps and complex log args are normalised to plain text,
 * `# @settings` reduces to the seven scalar keys, and binary bodies arrive as
 * the placeholder line written by the serializer.
 *
 * Used by `HistoryList` to populate the read-only request tab and "Repeat as
 * tab" actions. For the raw view, callers use the raw `.http` text returned
 * by `window.api.history.get` directly.
 */
export function activityLogToHistoryEntry(file: ActivityLogFile): HistoryEntry {
  const req = parseHttpMessage(file.requestRaw)
  const resp = parseHttpMessage(file.responseRaw)

  const reqM = req.firstLine.match(/^([A-Za-z]+)\s+(\S+)/)
  const method = reqM ? reqM[1]!.toUpperCase() : ''
  const url = findDirective(file, 'path-raw') ?? (reqM ? reqM[2]! : '')

  const stM = resp.firstLine.match(/^HTTP\/\S+\s+(\d{3})(?:\s+(.*))?$/)
  const status = stM ? Number(stM[1]) : 0
  const statusText = stM ? (stM[2] ?? '').trim() : ''

  const durationMs = Number(findDirective(file, 'duration-ms') ?? '0')

  const resolvedSettings: WorkspaceHttpSettings | undefined = (() => {
    const block = findHeaderBlock(file, 'settings')
    return block ? parseSettingsBlock(block) : undefined
  })()

  const id = findDirective(file, 'run-id') ?? ''
  const timestamp = findDirective(file, 'timestamp') ?? ''
  const requestId = findDirective(file, 'request-id')
  const sourceFile = findDirective(file, 'source-file') ?? null
  const remoteIp = findDirective(file, 'remote-ip')

  const preBlock = findTailBlock(file, 'script-results: pre-request')
  const postBlock = findTailBlock(file, 'script-results: post-response')
  const scriptResults: ScriptResultsBundle | undefined =
    preBlock || postBlock
      ? {
          preRequest: preBlock ? parseScriptResultLines(preBlock) : undefined,
          postResponse: postBlock ? parseScriptResultLines(postBlock) : undefined
        }
      : undefined

  const request: HttpRequest = {
    method,
    url,
    headers: req.headers,
    body: req.body || undefined
  }
  const response: HttpResponse = {
    status,
    statusText,
    headers: resp.headers,
    body: resp.body,
    timingMs: durationMs,
    sizeBytes: resp.body.length
  }

  const entry: HistoryEntry = {
    id,
    timestamp,
    request,
    response,
    sourceFile
  }
  if (requestId !== undefined) entry.requestId = requestId
  if (scriptResults !== undefined) entry.scriptResults = scriptResults
  if (resolvedSettings !== undefined) entry.resolvedSettings = resolvedSettings
  if (remoteIp !== undefined) entry.remoteIp = remoteIp
  return entry
}

/**
 * Convenience: read raw `.http` text + parse + rebuild a `HistoryEntry` in
 * one call. Throws on structural errors from the parser.
 */
export function historyEntryFromRaw(raw: string): HistoryEntry {
  return activityLogToHistoryEntry(_parseActivityLog(raw))
}
