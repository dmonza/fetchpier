// Requests-domain converters: HistoryEntry ↔ ActivityLogFile.
//
// The neutral activity-log core in `../activity-log/` knows nothing about
// `HistoryEntry` or HTTP roles. This adapter maps requests-side fields per
// REQ-0068 §6.5 (`id` → `# @run-id`, `requestId` → `# @request-id`,
// `response.timingMs` → `# @duration-ms`, etc.) and serializes the request
// + response as raw HTTP messages, with binary bodies replaced by the
// placeholder format.
//
// Decisions baked in for REQ-0068:
//   • Q1: top-level script errors persist as `# error: <message>` plus
//     filtered `# stack: <frame>` lines (node:vm / node:internal frames
//     stripped; workspace and script-context frames kept).
//   • Q2: `# @settings` block sits in the header (alongside `# @timestamp`),
//     not in the tail — matches where users see it in the source `.http`.
//   • Cookies are NOT a directive: they live in the `Cookie:` / `Set-Cookie:`
//     headers of the raw HTTP message (REQ §5.2.5 principle).

import {
  binaryPlaceholder,
  bodyByteLength,
  detectBinaryBody,
  fillReasonPhrase,
  type ActivityLogFile,
  type ExtensionBlock,
  type HeaderItem
} from '../activity-log'
import type {
  HistoryEntry,
  HttpRequest,
  HttpResponse,
  MultipartPart,
  ResolvedRequestSnapshot,
  ScriptArgSentinel,
  ScriptExecutionResult,
  ScriptLog,
  ScriptResultsBundle,
  ScriptTestResult,
  WorkspaceHttpSettings
} from '@shared/types'
import { assembleQuery, encodeTemplateComponent } from '@shared/lib/query-string'

// ── Header construction ───────────────────────────────────────────────────

/** Keys that the `# @settings` block reflects (REQ §5.2.5). camelCase. */
const SETTINGS_KEYS = [
  'verifySsl',
  'followRedirects',
  'maxRedirects',
  'followAuthorizationOnRedirect',
  'encodeUrl',
  'disableCookieJar',
  'httpVersion'
] as const

function settingsBlock(s: WorkspaceHttpSettings): HeaderItem {
  const bag = s as unknown as Record<string, unknown>
  const lines: string[] = []
  for (const k of SETTINGS_KEYS) {
    const v = bag[k]
    if (v === undefined) continue
    lines.push(`${k}: ${String(v)}`)
  }
  return { kind: 'block', name: 'settings', lines }
}

function scriptSummary(result: ScriptExecutionResult | undefined): string {
  if (!result) return 'skipped'
  const tests = result.testResults ?? []
  const passed = tests.filter((t) => t.passed).length
  const failed = tests.length - passed
  if (!result.success || failed > 0) return `failed (${passed} passed, ${failed} failed)`
  return 'ok'
}

/**
 * The request's template URL — `{{tokens}}` unresolved — with its query, for
 * `# @path-raw` (what Open and Repeat rebuild the request from). The desktop
 * sends the query as structured `params` beside a base `url`, so they are
 * assembled here the way the engine assembles them (enabled and keyed only,
 * value-less flags without `=`, a malformed pair as it was sent), with the
 * template encoding a `.http` file uses. A flat URL (command line) already holds
 * its query.
 */
function templateUrl(request: HttpRequest): string {
  if (!request.params) return request.url
  return assembleQuery(request.url, request.params, true, encodeTemplateComponent)
}

function buildHeader(entry: HistoryEntry): HeaderItem[] {
  const h: HeaderItem[] = []
  h.push({ kind: 'directive', key: 'timestamp', value: entry.timestamp })
  h.push({ kind: 'directive', key: 'run-id', value: entry.id })
  if (entry.requestId) h.push({ kind: 'directive', key: 'request-id', value: entry.requestId })
  if (entry.sourceFile) h.push({ kind: 'directive', key: 'source-file', value: entry.sourceFile })
  h.push({
    kind: 'directive',
    key: 'duration-ms',
    value: String(entry.response.timingMs ?? 0)
  })
  h.push({ kind: 'directive', key: 'path-raw', value: templateUrl(entry.request) })
  if (entry.remoteIp) h.push({ kind: 'directive', key: 'remote-ip', value: entry.remoteIp })
  // REQ-0070: flag that this entry is redacted (not a byte-faithful replay).
  const secretsMasked = entry.wireRequest?.secretsMasked
  if (secretsMasked && secretsMasked.length > 0) {
    h.push({ kind: 'directive', key: 'secrets-masked', value: secretsMasked.join(',') })
  }
  if (entry.scriptResults) {
    if ('preRequest' in entry.scriptResults || entry.scriptResults.preRequest !== undefined) {
      h.push({
        kind: 'directive',
        key: 'script-pre',
        value: scriptSummary(entry.scriptResults.preRequest)
      })
    }
    if ('postResponse' in entry.scriptResults || entry.scriptResults.postResponse !== undefined) {
      h.push({
        kind: 'directive',
        key: 'script-post',
        value: scriptSummary(entry.scriptResults.postResponse)
      })
    }
  }
  if (entry.resolvedSettings) h.push(settingsBlock(entry.resolvedSettings))
  return h
}

// ── Request/response raw construction ─────────────────────────────────────

function buildHeaders(headers: Record<string, string>): string[] {
  // Preserve insertion order — it matches the on-wire ordering captured by
  // the pipeline.
  const lines: string[] = []
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || v === null) continue
    lines.push(`${k}: ${v}`)
  }
  return lines
}

function buildBodySection(args: {
  headers: Record<string, string>
  body: string | undefined
  /** The body was decoded from its `Content-Encoding` (CLI hardening). */
  decoded?: boolean
}): string {
  const ctHeader = lookupHeader(args.headers, 'content-type')
  const ceHeader = lookupHeader(args.headers, 'content-encoding')
  const body = args.body ?? ''
  if (body === '') return '' // no body — caller still emits the blank
  const decision = detectBinaryBody({
    contentType: ctHeader,
    contentEncoding: ceHeader,
    body,
    decoded: args.decoded
  })
  if (!decision.isBinary) return body
  return binaryPlaceholder({
    byteLength: bodyByteLength(body),
    contentType: ctHeader,
    contentEncoding: ceHeader
  })
}

function lookupHeader(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase()
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === target) return headers[k]
  }
  return undefined
}

/**
 * Render the raw HTTP request that gets written into the history `.http`.
 *
 * The render uses the wire snapshot whenever it's present (method, URL,
 * headers, body all reflect what actually went on the wire — variables
 * interpolated, auth applied, multipart boundary injected, cookie jar
 * attached). The editor-side `req` is only consulted as a fallback for
 * callers that pre-date the snapshot, or to recover `multipartParts` (the
 * snapshot's multipart shape is a downgraded summary; the editor type
 * carries the richer info we need to reconstruct the body section).
 */
function buildRequestRaw(req: HttpRequest, wire?: ResolvedRequestSnapshot): string {
  const method = wire?.method ?? req.method
  const url = wire?.url ?? req.url
  const headers = redactSensitiveHeaders(wire?.headers ?? req.headers ?? {})
  const lines: string[] = [`${method.toUpperCase()} ${url} HTTP/1.1`, ...buildHeaders(headers)]
  let bodyText: string
  if (req.bodyType === 'multipart-form') {
    const ct = lookupHeader(headers, 'content-type')
    const boundary = extractBoundary(ct) ?? '<unknown-boundary>'
    // Prefer the wire snapshot: text part values are already interpolated,
    // matching what went on the wire. Fall back to the editor-side parts only
    // when there is no snapshot (legacy callers).
    if (wire?.multipartParts && wire.multipartParts.length > 0) {
      bodyText = buildMultipartBodyFromSnapshot(wire.multipartParts, boundary)
    } else if (req.multipartParts && req.multipartParts.length > 0) {
      bodyText = buildMultipartBody(req.multipartParts, boundary)
    } else {
      bodyText = ''
    }
  } else if (req.bodyType === 'binary' && req.binaryFile) {
    // Binary uploads send raw file bytes that never enter the snapshot's `body`
    // (and the editor never carries them in `req.body` either). Emit a textual
    // placeholder so the history records that bytes were sent.
    bodyText = `<bytes of ${req.binaryFile.ref} — ${humanReadableSize(req.binaryFile.sizeBytes)}>`
  } else {
    const body = wire?.body ?? req.body
    bodyText = buildBodySection({ headers, body })
  }
  const out: string[] = lines.slice()
  out.push('') // head/body separator
  if (bodyText !== '') out.push(bodyText)
  return out.join('\n') + '\n'
}

/**
 * Redact secret-bearing request headers before serializing into the history
 * `.http` on disk. Today this targets only `Authorization`: the scheme prefix
 * (`Bearer`, `Basic`, …) is preserved so the user still sees *how* the
 * request authenticated, but the credential portion is replaced with
 * `<redacted>`. Other potentially sensitive headers (e.g. `Cookie`,
 * `Set-Cookie`) are intentionally left untouched — the user only asked to
 * obfuscate `Authorization` for now.
 */
function redactSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'authorization') {
      out[k] = redactAuthorizationValue(v)
    } else {
      out[k] = v
    }
  }
  return out
}

function redactAuthorizationValue(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return value
  const spaceIdx = trimmed.indexOf(' ')
  if (spaceIdx > 0) return `${trimmed.slice(0, spaceIdx)} <redacted>`
  return '<redacted>'
}

/**
 * Extract the `boundary` token from a multipart Content-Type header value.
 * The encoder always emits an unquoted boundary, but we tolerate quoted form
 * for resilience.
 */
function extractBoundary(contentType: string | undefined): string | undefined {
  if (!contentType) return undefined
  const m = contentType.match(/boundary="?([^";\s]+)"?/i)
  return m ? m[1] : undefined
}

function humanReadableSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return `${bytes} bytes`
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function escapeQuotedHeaderParam(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

type SnapshotMultipartPart = NonNullable<ResolvedRequestSnapshot['multipartParts']>[number]

/**
 * Render the multipart wire body from the resolved snapshot — text part
 * values are post-interpolation, matching exactly what the encoder sent.
 * Preferred over `buildMultipartBody` whenever the wire snapshot is
 * available.
 */
function buildMultipartBodyFromSnapshot(parts: SnapshotMultipartPart[], boundary: string): string {
  const out: string[] = []
  for (const part of parts) {
    if (part.disabled) continue
    out.push(`--${boundary}`)
    if (part.kind === 'text') {
      out.push(`Content-Disposition: form-data; name="${escapeQuotedHeaderParam(part.name)}"`)
      if (part.contentType) out.push(`Content-Type: ${part.contentType}`)
      out.push('')
      for (const ln of (part.value ?? '').split('\n')) out.push(ln)
    } else {
      const filename = part.filename ?? ''
      out.push(
        `Content-Disposition: form-data; name="${escapeQuotedHeaderParam(part.name)}"; filename="${escapeQuotedHeaderParam(filename)}"`
      )
      if (part.contentType) out.push(`Content-Type: ${part.contentType}`)
      out.push('')
      out.push(
        `<bytes of ${part.fileRef ?? '<unknown>'} — ${humanReadableSize(part.sizeBytes ?? 0)}>`
      )
    }
  }
  out.push(`--${boundary}--`)
  return out.join('\n')
}

/**
 * Legacy fallback: render the multipart wire body from the editor-side parts.
 * Used only when no wire snapshot is available (older callers). Text values
 * here are NOT interpolated; the snapshot path above is preferred.
 */
function buildMultipartBody(parts: MultipartPart[], boundary: string): string {
  const out: string[] = []
  const enabled = parts.filter((p) => !p.disabled)
  for (const part of enabled) {
    out.push(`--${boundary}`)
    if (part.kind === 'text') {
      out.push(`Content-Disposition: form-data; name="${escapeQuotedHeaderParam(part.name)}"`)
      if (part.contentType) out.push(`Content-Type: ${part.contentType}`)
      out.push('')
      // Preserve embedded newlines verbatim.
      for (const ln of part.value.split('\n')) out.push(ln)
    } else {
      const filename = part.filename ?? part.file.originalName
      out.push(
        `Content-Disposition: form-data; name="${escapeQuotedHeaderParam(part.name)}"; filename="${escapeQuotedHeaderParam(filename)}"`
      )
      const ct = part.contentType ?? part.file.mimeType
      if (ct) out.push(`Content-Type: ${ct}`)
      out.push('')
      out.push(`<bytes of ${part.file.ref} — ${humanReadableSize(part.file.sizeBytes)}>`)
    }
  }
  out.push(`--${boundary}--`)
  return out.join('\n')
}

function buildStatusLine(resp: HttpResponse): string {
  const reason = (resp.statusText && resp.statusText.trim()) || fillReasonPhrase(resp.status)
  if (reason) return `HTTP/1.1 ${resp.status} ${reason}`
  return `HTTP/1.1 ${resp.status}`
}

function buildResponseRaw(resp: HttpResponse): string {
  const lines: string[] = [buildStatusLine(resp), ...buildHeaders(resp.headers ?? {})]
  // A compressed response the engine decoded is recorded as the text it is; the
  // kept `Content-Encoding` header must not turn it into a binary placeholder.
  const bodyText = buildBodySection({
    headers: resp.headers ?? {},
    body: resp.body,
    decoded: resp.decodingStatus === 'decoded'
  })
  const out: string[] = lines.slice()
  out.push('')
  if (bodyText !== '') out.push(bodyText)
  return out.join('\n') + '\n'
}

// ── Script results tail block (§5.2.6) ────────────────────────────────────

function renderScriptArg(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'object') {
    const sentinel = value as ScriptArgSentinel & Record<string, unknown>
    if ('__inspect' in sentinel) {
      switch (sentinel.__inspect) {
        case 'fn':
          return `[Function: ${(sentinel as { name?: string }).name ?? 'anonymous'}]`
        case 'circular':
          return '[Circular]'
        case 'truncated':
          return '[…]'
      }
    }
    try {
      return JSON.stringify(value)
    } catch {
      return '[unserializable]'
    }
  }
  return String(value)
}

function renderLog(log: ScriptLog): string {
  const text = (log.args ?? []).map(renderScriptArg).join(' ')
  return `${log.level}: ${text}`
}

function renderTest(test: ScriptTestResult): string {
  if (test.passed) return `pass: ${test.name}`
  const msg = (test.error ?? '').trim()
  return msg ? `fail: ${test.name} — ${msg}` : `fail: ${test.name}`
}

const NOISY_STACK_PATTERNS: readonly RegExp[] = [
  /node:vm\b/,
  /node:internal\//,
  /\bScript\.runInContext\b/,
  /\brunInThisContext\b/,
  /\brunInContext\b/
]

function isInterestingStackLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed) return false
  if (!trimmed.startsWith('at ')) return false
  for (const re of NOISY_STACK_PATTERNS) {
    if (re.test(trimmed)) return false
  }
  return true
}

/**
 * Q1 (REQ §10 — user override of (a)): persist the top-level error message
 * AND filtered stack frames. Frames inside Node's VM/internal machinery are
 * useless noise; we drop them. Frames that name the script context
 * (`<pre-request>`, `<post-response>`) or a workspace file (`.http` path) are
 * kept verbatim.
 */
function renderError(err: { message: string; stack?: string }): string[] {
  const out: string[] = []
  out.push(`error: ${err.message}`)
  const stack = err.stack ?? ''
  if (!stack) return out
  const lines = stack.split('\n')
  // Stack format: `ErrorName: <message>\n  at frame...\n  at frame...`
  // The first line repeats the message — skip it. We want only `at ...` lines.
  for (const raw of lines) {
    if (isInterestingStackLine(raw)) out.push(`stack: ${raw.trim().slice(3)}`) // strip leading `at `
  }
  return out
}

function buildScriptResultsBlock(
  phase: 'pre-request' | 'post-response',
  result: ScriptExecutionResult | undefined
): ExtensionBlock | null {
  if (!result) return null
  const hasLogs = (result.logs ?? []).length > 0
  const hasTests = (result.testResults ?? []).length > 0
  const hasError = !!result.error
  if (!hasLogs && !hasTests && !hasError) return null
  const lines: string[] = []
  for (const log of result.logs ?? []) lines.push(renderLog(log))
  for (const test of result.testResults ?? []) lines.push(renderTest(test))
  if (result.error) lines.push(...renderError(result.error))
  return { name: `script-results: ${phase}`, lines }
}

function buildTailBlocks(bundle: ScriptResultsBundle | undefined): ExtensionBlock[] {
  if (!bundle) return []
  const blocks: ExtensionBlock[] = []
  const pre = buildScriptResultsBlock('pre-request', bundle.preRequest)
  if (pre) blocks.push(pre)
  const post = buildScriptResultsBlock('post-response', bundle.postResponse)
  if (post) blocks.push(post)
  return blocks
}

/**
 * Convert a `HistoryEntry` into a neutral `ActivityLogFile`. The caller hands
 * this to `serializeActivityLog` to obtain the on-disk `.http` text.
 */
export function historyEntryToActivityLog(entry: HistoryEntry): ActivityLogFile {
  return {
    header: buildHeader(entry),
    requestRaw: buildRequestRaw(entry.request, entry.wireRequest),
    responseRaw: buildResponseRaw(entry.response),
    tailBlocks: buildTailBlocks(entry.scriptResults)
  }
}

// `activityLogToHistoryEntry` (the lossy ActivityLogFile → HistoryEntry rebuild)
// lives in `src/shared/lib/activity-log.ts` — the renderer-side reader. This core
// module only owns the forward serialization (HistoryEntry → ActivityLogFile text).
