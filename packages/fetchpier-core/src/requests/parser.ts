import type {
  AuthConfig,
  BinaryFileAttachment,
  DisabledRow,
  HeaderEntry,
  HttpRequest,
  HttpVersion,
  MultipartPart,
  ParsedHttpFile,
  RawSubtype,
  RequestSettings,
  SettingValue
} from '@shared/types'
import { authEcho } from '@shared/lib/auth-echo'
import { headersToRecord, removeHeaders } from '@shared/lib/headers'
import { parseDisabledRow } from '@shared/lib/disabled-rows'
import { mapTokenLiteralsSafe } from '@shared/lib/token-grammar'
import { lookupMimeType } from './binary-store'
import { MULTIPART_BEGIN_MARKER, parseMultipartBlock } from './multipart-parser'
import { findRequestSeparators } from './separator'

const RAW_SUBTYPE_VALUES: readonly RawSubtype[] = ['json', 'xml', 'javascript', 'text', 'html']
const RAW_SUBTYPE_MARKER = /^\s*#\s*@rawSubtype\s*:\s*(\S+)\s*$/

/**
 * `# @binary-file: <ref>` — set by the serializer when `bodyType === 'binary'`.
 * The ref points at a file staged in `<workspace>/requests/.files/`.
 */
const BINARY_FILE_MARKER = /^\s*#\s*@binary-file\s*:\s*(\S+)\s*$/
const BINARY_REF_VALIDATOR = /^[a-f0-9]{64}__.+$/

// Regex to detect {{variable}} placeholders
const VAR_REGEX = /\{\{([^}]+)\}\}/g

/**
 * Returns all unique variable names referenced inside `{{...}}` in the given text.
 */
function extractVariables(text: string): string[] {
  const names = new Set<string>()
  for (const match of text.matchAll(VAR_REGEX)) {
    names.add(match[1].trim())
  }
  return [...names]
}

/**
 * Returns true if the line is a comment (starts with `#` or `//`).
 * NOTE: `###` separator lines are NOT comments — the caller must handle them first.
 */
function isComment(line: string): boolean {
  const trimmed = line.trimStart()
  return trimmed.startsWith('#') || trimmed.startsWith('//')
}

// ── Script block extraction ────────────────────────────────────────────────

const PRE_MARKER = /^\s*#\s*@pre-request-script\b/
const POST_MARKER = /^\s*#\s*@post-response-script\b/
const END_MARKER = /^\s*#\s*@end-script\b/
const SETTINGS_MARKER = /^\s*#\s*@settings\b/
const SETTINGS_END_MARKER = /^\s*#\s*@end-settings\b/
const DISABLE_COOKIE_JAR_MARKER = /^\s*#\s*@disable-cookie-jar\b/
const AUTH_MARKER = /^\s*#\s*@auth\b/
const AUTH_END_MARKER = /^\s*#\s*@end-auth\b/

/**
 * Strip the leading `# ` (or `#`) prefix that comment-wraps each line of a
 * script block inside the .http file. Lines without the prefix are returned as-is.
 */
function stripScriptCommentPrefix(line: string): string {
  // Match an optional leading whitespace + `#` + optional single space
  const m = line.match(/^(\s*)#( ?)(.*)$/)
  if (!m) return line
  return m[1] + m[3]
}

/** Parses a single `# key: value` line inside the @auth block. */
function parseAuthFieldLine(line: string): [string, string] | null {
  const m = line.match(/^\s*#\s?(.*)$/)
  if (!m) return null
  const body = m[1].trim()
  if (!body) return null
  const colon = body.indexOf(':')
  if (colon < 0) return null
  return [body.slice(0, colon).trim(), body.slice(colon + 1).trim()]
}

/**
 * Rebuilds an `AuthConfig` from the raw `key → value` fields of an `@auth`
 * block, applying the validation rules of REQ-0083 §5.3 / §6.6. Returns
 * `undefined` (→ scheme `none`, lenient) when the block is malformed: unknown
 * `type`, a missing required field, or an unknown key. Each rejection emits a
 * non-fatal warning, mirroring the parser's existing handling of malformed
 * directives.
 */
function reconstructAuth(fields: Record<string, string>): AuthConfig | undefined {
  const warn = (reason: string): undefined => {
    console.warn(`[parser] Invalid @auth block: ${reason}`)
    return undefined
  }
  const unknownKeys = (allowed: readonly string[]): string | null => {
    const extra = Object.keys(fields).find((k) => !allowed.includes(k))
    return extra ?? null
  }

  const type = fields['type']
  if (type === undefined) return warn('missing required field "type"')

  switch (type) {
    case 'bearer': {
      const extra = unknownKeys(['type', 'token'])
      if (extra) return warn(`unknown key "${extra}"`)
      if (fields['token'] === undefined) return warn('"bearer" requires "token"')
      return { type: 'bearer', token: fields['token'] }
    }
    case 'basic': {
      const extra = unknownKeys(['type', 'username', 'password'])
      if (extra) return warn(`unknown key "${extra}"`)
      // username / password default to empty (REQ §5.3, §10 Q3).
      return {
        type: 'basic',
        username: fields['username'] ?? '',
        password: fields['password'] ?? ''
      }
    }
    case 'api-key': {
      const extra = unknownKeys(['type', 'key', 'value', 'location'])
      if (extra) return warn(`unknown key "${extra}"`)
      if (fields['key'] === undefined) return warn('"api-key" requires "key"')
      if (fields['value'] === undefined) return warn('"api-key" requires "value"')
      const location = fields['location'] ?? 'header'
      if (location !== 'header' && location !== 'query') {
        return warn(`unknown location "${location}"`)
      }
      return { type: 'api-key', key: fields['key'], value: fields['value'], location }
    }
    default:
      return warn(`unknown type "${type}"`)
  }
}

/**
 * Consumes a `# @auth … # @end-auth` block and reconstructs its scheme.
 *
 * The terminator is located **before** anything is consumed. Scanning forward
 * and consuming as it went meant an unterminated block swallowed the rest of the
 * block text — including the request line the user actually wrote, which then
 * vanished with no warning at all. Every other malformed-block case degrades the
 * same way instead: warn, no auth, request kept (CA-06). The block cannot span a
 * `###` separator, because the caller splits on those first.
 */
function extractAuthBlock(
  lines: string[],
  startIdx: number
): { auth?: AuthConfig; nextIdx: number } {
  let end = startIdx + 1
  while (end < lines.length && !AUTH_END_MARKER.test(lines[end])) end++

  if (end >= lines.length) {
    console.warn('[parser] Invalid @auth block: missing "# @end-auth"; the block is ignored')
    // Consume only the marker line. The field lines that follow are ordinary
    // comments, and the request parses normally.
    return { auth: undefined, nextIdx: startIdx + 1 }
  }

  const fields: Record<string, string> = {}
  for (let i = startIdx + 1; i < end; i++) {
    const parsed = parseAuthFieldLine(lines[i])
    if (parsed) fields[parsed[0]] = parsed[1]
  }
  return { auth: reconstructAuth(fields), nextIdx: end + 1 }
}

const HTTP_VERSION_VALUES: readonly HttpVersion[] = ['auto', 'http1', 'http2']

/** Parses a single `key: value` line inside the @settings block into a typed override. */
function parseSettingLine(line: string): [keyof RequestSettings, SettingValue<unknown>] | null {
  // Strip leading `# ` (or `#`) prefix
  const m = line.match(/^\s*#\s?(.*)$/)
  if (!m) return null
  const body = m[1].trim()
  if (!body) return null

  const colon = body.indexOf(':')
  if (colon < 0) return null
  const key = body.slice(0, colon).trim()
  const raw = body.slice(colon + 1).trim()

  const warn = (reason: string): void => {
    console.warn(`[parser] Invalid @settings value for "${key}": ${reason}`)
  }

  switch (key) {
    case 'httpVersion': {
      if (!(HTTP_VERSION_VALUES as readonly string[]).includes(raw)) {
        warn(`unknown httpVersion "${raw}"`)
        return null
      }
      return [key, { inherit: false, value: raw as HttpVersion }]
    }
    case 'verifySsl':
    case 'followRedirects':
    case 'followAuthorizationOnRedirect':
    case 'encodeUrl':
    case 'disableCookieJar': {
      if (raw === 'true') return [key, { inherit: false, value: true }]
      if (raw === 'false') return [key, { inherit: false, value: false }]
      warn(`expected boolean, got "${raw}"`)
      return null
    }
    case 'maxRedirects': {
      const n = Number(raw)
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
        warn(`expected non-negative integer, got "${raw}"`)
        return null
      }
      return [key, { inherit: false, value: n }]
    }
    default:
      console.warn(`[parser] Unknown @settings key "${key}"`)
      return null
  }
}

function extractSettingsBlock(
  lines: string[],
  startIdx: number
): { settings: RequestSettings; nextIdx: number } {
  const settings: RequestSettings = {}
  let i = startIdx + 1
  while (i < lines.length && !SETTINGS_END_MARKER.test(lines[i])) {
    const parsed = parseSettingLine(lines[i])
    if (parsed) {
      const [key, value] = parsed
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(settings as any)[key] = value
    }
    i++
  }
  if (i < lines.length && SETTINGS_END_MARKER.test(lines[i])) i++
  return { settings, nextIdx: i }
}

/**
 * Extract one `# @pre-request-script` / `# @post-response-script` section that
 * starts at `lines[startIdx]` (the marker line) and runs to its `# @end-script`.
 * Returns the de-commented script content and the index just past the end marker.
 */
function extractScriptAt(lines: string[], startIdx: number): { content: string; nextIdx: number } {
  const scriptLines: string[] = []
  let i = startIdx + 1
  while (i < lines.length && !END_MARKER.test(lines[i])) {
    scriptLines.push(stripScriptCommentPrefix(lines[i]))
    i++
  }
  if (i < lines.length && END_MARKER.test(lines[i])) i++ // skip the end marker
  // Trim surrounding blank lines but preserve internal structure.
  while (scriptLines.length > 0 && scriptLines[scriptLines.length - 1].trim() === '')
    scriptLines.pop()
  while (scriptLines.length > 0 && scriptLines[0].trim() === '') scriptLines.shift()
  return { content: scriptLines.join('\n'), nextIdx: i }
}

/**
 * Removes every query parameter whose (token-aware decoded) name matches `name`
 * from a URL — the api-key-in-query surface an active scheme owns. Returns the
 * rewritten URL, or `null` when nothing matched (caller leaves the URL untouched).
 * Remaining parameters keep their original encoding verbatim.
 */
function stripQueryParamsByName(url: string, name: string): string | null {
  const qIdx = url.indexOf('?')
  if (qIdx === -1) return null
  const base = url.slice(0, qIdx)
  const segs = url.slice(qIdx + 1).split('&')
  const kept = segs.filter((seg) => {
    const eq = seg.indexOf('=')
    const rawKey = eq === -1 ? seg : seg.slice(0, eq)
    // A malformed percent-escape in a parameter name used to abort the whole
    // parse here, so the file would not open at all (REQ-0113 §6.6). The grammar
    // now contains and reports it; compare the author's bytes instead. The
    // parameter is simply not recognized as this scheme's echo, so it survives.
    const decoded = mapTokenLiteralsSafe(rawKey, decodeURIComponent)
    return (decoded.failed ? rawKey : decoded.text) !== name
  })
  if (kept.length === segs.length) return null
  return kept.length > 0 ? `${base}?${kept.join('&')}` : base
}

/**
 * Parse the request line `METHOD URL [HTTP-VERSION]`. The trailing token is
 * treated as a version only when it has the shape of an HTTP version; otherwise
 * it is part of the URL, so a URL containing a literal space is preserved
 * verbatim (`.http` round-trip fidelity, CA-07).
 */
function parseRequestLine(line: string): { method: string | null; url: string } {
  const trimmed = line.trim()
  const firstSpace = trimmed.search(/\s/)
  if (firstSpace === -1) return { method: null, url: '' }
  const method = trimmed.slice(0, firstSpace).toUpperCase()
  const rest = trimmed.slice(firstSpace + 1).trim()
  if (rest === '') return { method: null, url: '' }
  // Strip a trailing HTTP-version token only when it is one; everything else
  // (including internal spaces) is the URL.
  const m = rest.match(/^(.*\S)\s+(HTTP\/\d(?:\.\d)?)$/i)
  return { method, url: m ? m[1] : rest }
}

/**
 * Consume a single optional leading space after the header colon; preserve the
 * rest of the value verbatim, including any further leading spaces and all
 * trailing whitespace (CA-05).
 */
function stripOneLeadingSpace(value: string): string {
  return value.startsWith(' ') ? value.slice(1) : value
}

/**
 * Extract the body verbatim from `block` starting at line `startLine`, removing
 * exactly one structural trailing newline (the serializer always terminates the
 * file with `\n`; a non-last block ends with the `\n` before its separator). The
 * single removal is what makes a body with vs. without a final newline round-trip
 * distinctly (CA-06). Returns `undefined` when there is no body content.
 */
function extractBodyVerbatim(
  block: string,
  lines: string[],
  startLine: number
): string | undefined {
  if (startLine >= lines.length) return undefined
  let offset = 0
  for (let k = 0; k < startLine; k += 1) offset += lines[k].length + 1
  let raw = block.slice(offset)
  if (raw.endsWith('\n')) raw = raw.slice(0, -1)
  return raw === '' ? undefined : raw
}

/**
 * Transitional read-shim (D2): an older file wrote the post-response script
 * AFTER the body. With body-to-boundary parsing that wrapper would otherwise be
 * swallowed as body content; recover it when a complete
 * `# @post-response-script … # @end-script` wrapper sits at the end of the body.
 */
function recoverTrailingPostScript(body: string): { script: string; body: string } | null {
  const bl = body.split('\n')
  let end = bl.length - 1
  while (end >= 0 && bl[end].trim() === '') end -= 1
  if (end < 0 || !END_MARKER.test(bl[end])) return null
  let start = -1
  for (let k = end - 1; k >= 0; k -= 1) {
    if (POST_MARKER.test(bl[k])) {
      start = k
      break
    }
    if (PRE_MARKER.test(bl[k]) || END_MARKER.test(bl[k])) return null
  }
  if (start === -1) return null
  const scriptLines = bl.slice(start + 1, end).map(stripScriptCommentPrefix)
  while (scriptLines.length > 0 && scriptLines[scriptLines.length - 1].trim() === '')
    scriptLines.pop()
  while (scriptLines.length > 0 && scriptLines[0].trim() === '') scriptLines.shift()
  let newEnd = start - 1
  while (newEnd >= 0 && bl[newEnd].trim() === '') newEnd -= 1
  const newBody = newEnd >= 0 ? bl.slice(0, newEnd + 1).join('\n') : ''
  return { script: scriptLines.join('\n'), body: newBody }
}

/**
 * Parses a single request block (the text of one request, the separator
 * excluded) and returns a structured `HttpRequest`, or `null` if the block is
 * empty / has no valid request line.
 *
 * Metadata directives (scripts, auth, settings, cookie-jar, raw-subtype, binary
 * reference) are recognized **only** in the metadata region, before the request
 * line. After the header section everything is opaque body — a `# @…` line there
 * is content, never a directive (CA-01/CA-02). Multipart is the single
 * body-region exception, recognized as the first non-blank body line.
 */
function parseRequestBlock(block: string): HttpRequest | null {
  const normalized = block.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n')

  // ── Metadata region — directives recognized only before the request line ──
  let pre: string | undefined
  let post: string | undefined
  let settings: RequestSettings | undefined
  let disableCookieJar: boolean | undefined
  let auth: AuthConfig | undefined
  let rawSubtype: RawSubtype | undefined
  let binaryFile: BinaryFileAttachment | undefined
  const disabledRows: DisabledRow[] = []
  const comments: string[] = []
  let normalizedOnLoad = false

  const readBinaryRef = (ref: string): void => {
    if (BINARY_REF_VALIDATOR.test(ref)) {
      const originalName = ref.slice(66)
      binaryFile = { ref, originalName, sizeBytes: 0, mimeType: lookupMimeType(originalName) }
    } else {
      console.warn(
        `[parser] Ignoring invalid # @binary-file: ref "${ref}" — expected <64-hex>__<name>`
      )
    }
  }
  const readRawSubtype = (value: string): void => {
    const candidate = value.toLowerCase()
    if ((RAW_SUBTYPE_VALUES as readonly string[]).includes(candidate)) {
      rawSubtype = candidate as RawSubtype
    }
  }
  // A `# @rawSubtype:` line carrying a recognized value, or null. Used to decide
  // whether the transitional body-shim should consume an old first-body-line
  // marker (recognized values only — an unknown value stays as body content).
  const validRawSubtypeAt = (line: string): RawSubtype | null => {
    const m = line.match(RAW_SUBTYPE_MARKER)
    if (!m) return null
    const candidate = m[1].toLowerCase()
    return (RAW_SUBTYPE_VALUES as readonly string[]).includes(candidate)
      ? (candidate as RawSubtype)
      : null
  }

  let i = 0
  let requestLineIdx = -1
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      i += 1
      continue
    }
    if (isComment(line)) {
      if (DISABLE_COOKIE_JAR_MARKER.test(line)) {
        disableCookieJar = true
        i += 1
        continue
      }
      if (SETTINGS_MARKER.test(line)) {
        const x = extractSettingsBlock(lines, i)
        if (Object.keys(x.settings).length > 0) settings = x.settings
        i = x.nextIdx
        continue
      }
      if (AUTH_MARKER.test(line)) {
        const x = extractAuthBlock(lines, i)
        if (x.auth) auth = x.auth
        i = x.nextIdx
        continue
      }
      if (PRE_MARKER.test(line)) {
        const x = extractScriptAt(lines, i)
        pre = x.content
        i = x.nextIdx
        continue
      }
      if (POST_MARKER.test(line)) {
        const x = extractScriptAt(lines, i)
        post = x.content
        i = x.nextIdx
        continue
      }
      const rs = line.match(RAW_SUBTYPE_MARKER)
      if (rs) {
        readRawSubtype(rs[1])
        i += 1
        continue
      }
      const bf = line.match(BINARY_FILE_MARKER)
      if (bf) {
        readBinaryRef(bf[1])
        i += 1
        continue
      }
      const dis = parseDisabledRow(line)
      if (dis) {
        disabledRows.push(dis)
        i += 1
        continue
      }
      // `# @id` is file-level metadata (extractRequestId), not a user comment.
      // Any other `#` / `//` line is a preserved user comment.
      if (!/^\s*#\s*@id\b/.test(line)) comments.push(line)
      i += 1
      continue
    }
    requestLineIdx = i
    break
  }

  if (requestLineIdx === -1) return null

  const { method, url: parsedUrl } = parseRequestLine(lines[requestLineIdx])
  if (method === null) return null
  let url = parsedUrl

  // ── Header section — until the first blank line ──────────────────────────
  let headerList: HeaderEntry[] = []
  let bodyStartLine = -1
  for (let k = requestLineIdx + 1; k < lines.length; k += 1) {
    if (lines[k].trim() === '') {
      bodyStartLine = k + 1
      break
    }
    if (isComment(lines[k])) {
      comments.push(lines[k])
      continue
    }
    const colonIdx = lines[k].indexOf(':')
    if (colonIdx > 0) {
      headerList.push({
        name: lines[k].slice(0, colonIdx).trim(),
        value: stripOneLeadingSpace(lines[k].slice(colonIdx + 1))
      })
    } else {
      // Neither a header nor a comment — a stray line. Dropped on save; the
      // tab is marked modified-with-a-reason (D19/§6.9).
      normalizedOnLoad = true
    }
  }

  // Auth reconciliation (REQ-0083 §6.2): the scheme owns its header / query name.
  if (auth) {
    const echo = authEcho(auth)
    if (echo.header) headerList = removeHeaders(headerList, echo.header.name)
    if (echo.query) {
      const stripped = stripQueryParamsByName(url, echo.query.key)
      if (stripped !== null) url = stripped
    }
  }

  // ── Body — verbatim from the header-separator blank line to EOF ──────────
  let body: string | undefined
  let multipartParts: MultipartPart[] | undefined
  if (bodyStartLine !== -1 && bodyStartLine <= lines.length) {
    let firstContent = bodyStartLine
    while (firstContent < lines.length && lines[firstContent].trim() === '') firstContent += 1

    if (firstContent < lines.length && MULTIPART_BEGIN_MARKER.test(lines[firstContent])) {
      // Multipart block — recognized only as the first non-blank body line.
      const result = parseMultipartBlock(lines, firstContent)
      multipartParts = result.parts
      for (const w of result.warnings) console.warn(`[parser] ${w}`)
    } else if (
      firstContent < lines.length &&
      rawSubtype === undefined &&
      binaryFile === undefined &&
      validRawSubtypeAt(lines[firstContent]) !== null
    ) {
      // Transitional read-shim: old files wrote a (recognized) `# @rawSubtype:`
      // as the first body line; recover it, the real body follows. An unknown
      // value is left as body content (CA-02).
      rawSubtype = validRawSubtypeAt(lines[firstContent])!
      body = extractBodyVerbatim(normalized, lines, firstContent + 1)
    } else if (
      firstContent < lines.length &&
      binaryFile === undefined &&
      BINARY_FILE_MARKER.test(lines[firstContent])
    ) {
      // Transitional read-shim: old `# @binary-file:` as the first body line.
      // Any trailing content is extracted so the binary/body collision below
      // warns and discards it (preserving the prior behavior).
      readBinaryRef(lines[firstContent].match(BINARY_FILE_MARKER)![1])
      body = extractBodyVerbatim(normalized, lines, firstContent + 1)
    } else {
      body = extractBodyVerbatim(normalized, lines, bodyStartLine)
    }
  }

  // Transitional read-shim (D2): a post-response script written after the body.
  if (body !== undefined && post === undefined) {
    const shim = recoverTrailingPostScript(body)
    if (shim) {
      post = shim.script
      body = shim.body === '' ? undefined : shim.body
    }
  }

  // Collision: a non-empty body alongside `# @binary-file:` — prefer the binary.
  if (binaryFile && body !== undefined && body.trim() !== '') {
    console.warn(
      '[parser] `# @binary-file:` is set but the body section is non-empty — sending binary, body discarded'
    )
    body = undefined
  }

  return {
    method,
    url,
    headers: headersToRecord(headerList),
    headerList,
    disabledRows: disabledRows.length > 0 ? disabledRows : undefined,
    comments: comments.length > 0 ? comments : undefined,
    normalizedOnLoad: normalizedOnLoad || undefined,
    body: multipartParts ? undefined : body,
    rawText: block.trim(),
    auth,
    preRequestScript: pre,
    postResponseScript: post,
    settings,
    disableCookieJar,
    rawSubtype,
    bodyType: multipartParts ? 'multipart-form' : binaryFile ? 'binary' : undefined,
    binaryFile,
    multipartParts
  }
}

/** UUID regex used to validate `# @id` values */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Extracts the request UUID from the file-level `# @id <uuid>` metadata comment,
 * if present anywhere in the top-level comment block before the first request line.
 */
function extractRequestId(content: string): string | undefined {
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('#') && !trimmed.startsWith('//')) break
    const match = trimmed.match(/^#\s*@id\s+(\S+)/)
    if (match && UUID_REGEX.test(match[1])) return match[1]
  }
  return undefined
}

/**
 * Parses the full content of a `.http` file and returns all requests found,
 * plus the list of unique `{{variable}}` names referenced anywhere in the file.
 *
 * Spec:
 * - Requests are separated by `###` lines, but only when the next content line
 *   is a request line (lookahead; bias to not split). A `###` inside a body is
 *   therefore body content (CA-01).
 * - Comments are lines starting with `#` or `//` (in the metadata/header
 *   regions; inside a body they are content).
 * - Variables `{{name}}` are detected but NOT resolved here.
 * - CRLF and LF line endings are both supported (normalized to LF).
 */
export function parseHttpFile(content: string): ParsedHttpFile {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const requestId = extractRequestId(normalized)

  const lines = normalized.split('\n')
  const separators = findRequestSeparators(lines)

  // Char offset of each line's start, so blocks keep their exact bytes
  // (including the trailing newline that body extraction depends on).
  const lineOffset: number[] = []
  let acc = 0
  for (const l of lines) {
    lineOffset.push(acc)
    acc += l.length + 1
  }
  const offsetOf = (lineIdx: number): number =>
    lineIdx < lineOffset.length ? lineOffset[lineIdx] : normalized.length

  // Split into block texts at the confirmed separator lines (the `###` line is
  // excluded from every block — it lives only in the preserved tail).
  const blockTexts: string[] = []
  let blockStartLine = 0
  for (const sep of separators) {
    blockTexts.push(normalized.slice(offsetOf(blockStartLine), offsetOf(sep)))
    blockStartLine = sep + 1
  }
  blockTexts.push(normalized.slice(offsetOf(blockStartLine)))

  const requests: HttpRequest[] = []
  for (const block of blockTexts) {
    if (block.trim() === '') continue
    const req = parseRequestBlock(block)
    if (req) requests.push(req)
  }

  // Verbatim remainder from the first confirmed separator — the editing surface
  // re-emits it byte-for-byte; both surfaces execute only the first request.
  const tail = separators.length > 0 ? normalized.slice(offsetOf(separators[0])) : undefined

  const variablesUsed = extractVariables(normalized)

  return { requests, variablesUsed, requestId, tail }
}
