import type {
  RequestEditorState,
  KeyValuePair,
  AuthConfig,
  RequestSettings,
  MultipartPart
} from '../types'
import {
  encodeContentDisposition,
  humanReadableSize,
  resolvePartContentType,
  resolveWireFilename,
  serializeAttributeValue
} from './multipart-format'
import { mapTokenLiterals } from './token-grammar'
import { serializeDisabledRow } from './disabled-rows'
import { authEcho } from './auth-echo'

/**
 * Converts enabled key-value pairs to `?key=value&...` query string (without
 * leading `?`). `{{variable}}` tokens are preserved verbatim while the literal
 * remainder of each key/value is percent-encoded, so stored tokens stay
 * resolvable and human-readable (REQ-0080 §6.1).
 */
function buildQueryString(params: KeyValuePair[]): string {
  return (
    params
      // A malformed param (REQ-0086) is dropped on save: its intended bytes cannot
      // be reliably inferred, so normalization removes it rather than re-encoding
      // the raw sequence. The user clears the flag by editing the row first.
      .filter((p) => p.enabled && p.key.trim() !== '' && !p.malformed)
      .map((p) => {
        const key = mapTokenLiterals(p.key, encodeURIComponent)
        // REQ-0124: a value-less parameter is stored as its bare key, so the
        // authored form survives the save and the file stays runnable as written.
        if (p.valueless) return key
        return `${key}=${mapTokenLiterals(p.value, encodeURIComponent)}`
      })
      .join('&')
  )
}

/** Appends query params to a URL (handles already-existing `?` in base URL) */
function applyParamsToUrl(baseUrl: string, params: KeyValuePair[]): string {
  const qs = buildQueryString(params)
  if (!qs) return baseUrl
  return baseUrl.includes('?') ? `${baseUrl}&${qs}` : `${baseUrl}?${qs}`
}

/**
 * Serializes a non-`none` auth scheme into its `# @auth … # @end-auth`
 * comment-directive block (REQ-0083 §5.2 — the source of truth). Field order is
 * fixed for byte-stable output. `none` produces no block (returns `[]`). Field
 * values are written verbatim, including any `{{variable}}` references.
 */
function serializeAuthBlock(auth: AuthConfig): string[] {
  if (auth.type === 'none') return []
  const out = ['# @auth', `# type: ${auth.type}`]
  switch (auth.type) {
    case 'bearer':
      out.push(`# token: ${auth.token}`)
      break
    case 'basic':
      out.push(`# username: ${auth.username}`)
      out.push(`# password: ${auth.password}`)
      break
    case 'api-key':
      out.push(`# location: ${auth.location}`)
      out.push(`# key: ${auth.key}`)
      out.push(`# value: ${auth.value}`)
      break
  }
  out.push('# @end-auth')
  return out
}

/**
 * Wraps every line of a script body with the `.http` comment prefix so the
 * resulting block is a sequence of valid comment lines.
 */
function serializeScriptBlock(marker: string, script: string): string[] {
  const out: string[] = []
  out.push(`# ${marker}`)
  const lines = script.replace(/\r\n?/g, '\n').split('\n')
  for (const line of lines) {
    // Empty lines become a single `#` (no trailing space) to keep files clean
    out.push(line === '' ? '#' : `# ${line}`)
  }
  out.push('# @end-script')
  return out
}

// ── Multipart serialisation (REQ-0066) ─────────────────────────────────────

/**
 * The boundary placeholder used inside the wire-preview block. The real
 * boundary is generated per send by the encoder; the preview is rendered
 * with this sentinel so users reading the `.http` file see the shape of
 * the wire request without exposing a fake-but-realistic boundary.
 */
const PREVIEW_BOUNDARY_PLACEHOLDER = '<boundary>'

/**
 * Fixed disclaimer printed as the only `# `-prefixed line inside the preview
 * block. Stable across saves so byte-identical re-serialisation holds.
 */
const PREVIEW_DISCLAIMER =
  'Auto-generated representation of the wire. Regenerated on save from the parts above; edits here are overwritten. The actual request may differ: the boundary is generated at send time, file bytes are not shown, and {{variables}} are resolved against the active environment.'

/**
 * Decide whether a text-part value needs a heredoc to round-trip safely. A
 * heredoc is required when the value spans multiple lines, opens with `<<<`
 * (which would otherwise be mistaken for a heredoc opener), or contains a
 * line that would parse as a `# @multipart-part` or `# @multipart end`
 * marker.
 */
function shouldUseHeredoc(value: string): boolean {
  if (value === '') return false
  if (value.includes('\n')) return true
  if (value.startsWith('<<<')) return true
  if (/^\s*#\s*@multipart(\s|-)/.test(value)) return true
  return false
}

/**
 * Pick a heredoc delimiter that does not appear as a standalone line inside
 * the value. Starts at `EOT` and appends `_1`, `_2`, ... if needed.
 */
function pickHeredocDelimiter(value: string): string {
  const linesInValue = value.split('\n')
  let delim = 'EOT'
  let i = 0
  while (linesInValue.includes(delim)) {
    i += 1
    delim = `EOT_${i}`
  }
  return delim
}

/** Serialise one `# @multipart-part` marker line and (for text parts) its value. */
function serializePart(part: MultipartPart): string[] {
  const attrs: string[] = []
  attrs.push(`name=${serializeAttributeValue(part.name)}`)
  attrs.push(`type=${part.kind}`)
  if (part.kind === 'file') {
    // Quoted when needed, like every other attribute: a staged name may hold
    // spaces, and an unquoted value ends at the first one on reload (FMT-04).
    attrs.push(`file=${serializeAttributeValue(part.file.ref)}`)
    if (part.filename !== undefined) {
      attrs.push(`filename=${serializeAttributeValue(part.filename)}`)
    }
  }
  if (part.contentType !== undefined && part.contentType !== '') {
    attrs.push(`content-type=${serializeAttributeValue(part.contentType)}`)
  }
  if (part.disabled) attrs.push('disabled=true')
  const out: string[] = [`# @multipart-part ${attrs.join(' ')}`]
  if (part.kind === 'text' && part.value !== '') {
    if (shouldUseHeredoc(part.value)) {
      const delim = pickHeredocDelimiter(part.value)
      out.push(`<<<${delim}`)
      for (const ln of part.value.split('\n')) out.push(ln)
      out.push(delim)
    } else {
      out.push(part.value)
    }
  }
  return out
}

/**
 * Render the non-authoritative wire-preview block for the enabled parts.
 * Disabled parts are excluded — the preview reflects the wire, not the
 * editor state. The boundary appears as the literal `<boundary>` (the real
 * value doesn't exist until send time). The block is regenerated on every
 * save and treated as opaque by the parser.
 */
function renderPreviewBlock(parts: MultipartPart[]): string[] {
  const lines: string[] = []
  lines.push('# @multipart-preview begin')
  lines.push(`# ${PREVIEW_DISCLAIMER}`)
  lines.push(`Content-Type: multipart/form-data; boundary=<generated-at-send>`)
  lines.push('')
  const enabled = parts.filter((p) => !p.disabled)
  for (const part of enabled) {
    lines.push(`--${PREVIEW_BOUNDARY_PLACEHOLDER}`)
    const wireFilename = part.kind === 'file' ? resolveWireFilename(part) : undefined
    lines.push(`Content-Disposition: ${encodeContentDisposition(part, wireFilename)}`)
    const ct = resolvePartContentType(part)
    if (ct) lines.push(`Content-Type: ${ct}`)
    lines.push('')
    if (part.kind === 'text') {
      // {{variables}} stay verbatim in the preview (no environment context).
      for (const ln of part.value.split('\n')) lines.push(ln)
    } else {
      lines.push(`<bytes of ${part.file.ref} — ${humanReadableSize(part.file.sizeBytes)}>`)
    }
  }
  lines.push(`--${PREVIEW_BOUNDARY_PLACEHOLDER}--`)
  lines.push('# @multipart-preview end')
  return lines
}

/**
 * Serialise the full multipart section: the authoritative `# @multipart`
 * markers block followed immediately by the regenerated preview block.
 * Disabled parts are persisted in the markers block but excluded from the
 * preview.
 */
function serializeMultipartSection(parts: MultipartPart[]): string[] {
  // A malformed part (carrying a parse error / unreadable reference) is dropped
  // on save — normalize to what the editing surface represents, honest removal,
  // never the silent text downgrade this REQ removes (D15 / §6.7, Q1 resolution).
  const kept = parts.filter((p) => (p as { parseError?: string }).parseError === undefined)
  const out: string[] = []
  out.push('# @multipart begin')
  for (const part of kept) out.push(...serializePart(part))
  out.push('# @multipart end')
  out.push(...renderPreviewBlock(kept))
  return out
}

/**
 * Serializes only the overridden (inherit:false) fields of a RequestSettings
 * into the `# @settings ... # @end-settings` comment block. Returns an empty
 * array if there are no overrides (so the caller omits the block entirely).
 *
 * The cookie-jar override has two spellings: `true` is written as the
 * `# @disable-cookie-jar` marker (by the caller, so existing files keep their
 * bytes), `false` — "use the jar" in a workspace that disables it — only here.
 */
function serializeSettingsBlock(settings: RequestSettings | undefined): string[] {
  if (!settings) return []
  const entries: [string, string | number | boolean][] = []

  const fields: readonly (keyof RequestSettings)[] = [
    'httpVersion',
    'verifySsl',
    'followRedirects',
    'maxRedirects',
    'followAuthorizationOnRedirect',
    'encodeUrl',
    'disableCookieJar'
  ]
  for (const field of fields) {
    const v = settings[field]
    if (!v || v.inherit !== false) continue
    if (field === 'disableCookieJar' && v.value === true) continue
    entries.push([field, v.value as string | number | boolean])
  }
  if (entries.length === 0) return []

  const out = ['# @settings']
  for (const [k, v] of entries) out.push(`# ${k}: ${String(v)}`)
  out.push('# @end-settings')
  return out
}

/**
 * Serializes a `RequestEditorState` back into a valid `.http` file string.
 * When `requestId` is provided, prepends `# @id <uuid>` as the first line.
 *
 * Format:
 * ```
 * # @id <uuid>
 * # @pre-request-script
 * # ...
 * # @end-script
 * METHOD URL
 * Header: value
 *
 * body
 *
 * # @post-response-script
 * # ...
 * # @end-script
 * ```
 */
export function serializeRequest(state: RequestEditorState, requestId?: string): string {
  const { method, url, params, headers, bodyType, rawSubtype, body, auth } = state

  // The deterministic echo the active scheme materializes (REQ-0083 §5.2). The
  // header echo is written first (immediately after the request line, before
  // hand-authored headers); the api-key query echo is the leading query
  // parameter — both match send-time ordering (§10 Q1, option a).
  const echo = authEcho(auth)
  const authParams: KeyValuePair[] = echo.query
    ? [{ id: '__auth__', key: echo.query.key, value: echo.query.value, enabled: true }]
    : []
  // An active scheme owns its name: a manual same-name parameter is dropped, not
  // persisted alongside the echo (REQ-0083 §6.4, owner decision).
  const manualParams = echo.query
    ? params.filter((p) => p.key.trim().toLowerCase() !== echo.query!.key.trim().toLowerCase())
    : params
  const allParams = [...authParams, ...manualParams]
  const finalUrl = applyParamsToUrl(url, allParams)

  // Compute the body text up front so the body-mode declarations (raw subtype,
  // binary reference) can be written in the metadata region. Canonical file
  // order (`.http` round-trip fidelity, D-META): all `# @…` metadata → request
  // line → header section → blank line → body (multipart is the exception — it
  // lives in the body region).
  const isMultipart = bodyType === 'multipart-form'
  const isBinary = bodyType === 'binary'
  let bodyText = ''
  if (bodyType === 'x-www-form-urlencoded') {
    const enabledFields = (state.formFields ?? []).filter((f) => f.enabled && f.key)
    if (enabledFields.length > 0) {
      // Token-aware (REQ-0081 §6.4): `{{variable}}` tokens are written verbatim
      // while the literal remainder of each field key/value is percent-encoded.
      bodyText = enabledFields
        .map(
          (f) =>
            `${mapTokenLiterals(f.key, encodeURIComponent)}=${mapTokenLiterals(f.value, encodeURIComponent)}`
        )
        .join('&')
    }
  } else if (!isMultipart && !isBinary) {
    bodyText = body
  }
  // A raw/form body is written verbatim — trailing blank lines and the presence
  // or absence of a final newline are content and must round-trip (CA-06).
  const hasRawBody = !isMultipart && !isBinary && bodyType !== 'none' && bodyText !== ''

  const lines: string[] = []

  // ── Metadata region — all `# @…` directives, before the request line ──────
  if (requestId) lines.push(`# @id ${requestId}`)

  // Disable cookie jar shortcut marker (when overridden to true; a `false`
  // override is a line of the settings block below)
  const djcOverride = state.settings?.disableCookieJar
  if (djcOverride && djcOverride.inherit === false && djcOverride.value === true) {
    lines.push('# @disable-cookie-jar')
  }

  // Settings block (only overrides)
  const settingsLines = serializeSettingsBlock(state.settings)
  if (settingsLines.length > 0) lines.push(...settingsLines)

  // Auth block (source of truth; `none` writes nothing) — REQ-0083 §5.2.
  const authLines = serializeAuthBlock(auth)
  if (authLines.length > 0) lines.push(...authLines)

  // Both scripts live in the metadata region (D2): a post-response script is no
  // longer written after the body.
  if (state.preRequestScript && state.preRequestScript.trim()) {
    lines.push(...serializeScriptBlock('@pre-request-script', state.preRequestScript))
  }
  if (state.postResponseScript && state.postResponseScript.trim()) {
    lines.push(...serializeScriptBlock('@post-response-script', state.postResponseScript))
  }

  // Body-mode declarations (recognized only in the metadata region). The raw
  // subtype is skipped for plain text (the default) to avoid noise.
  if (hasRawBody && bodyType === 'raw' && rawSubtype && rawSubtype !== 'text') {
    lines.push(`# @rawSubtype: ${rawSubtype}`)
  }
  if (isBinary && state.binaryFile?.ref) {
    lines.push(`# @binary-file: ${state.binaryFile.ref}`)
  } else if (isBinary && state.invalidBinaryRef !== undefined) {
    // The file's reference was not valid and no file replaced it: kept as
    // written, so a save never deletes what the author attached.
    lines.push(`# @binary-file: ${state.invalidBinaryRef}`)
  }

  // Disabled rows (`# @disabled`) — one per disabled header / param / field, with
  // `pos` = the row's index in its full author-ordered list, so it re-interleaves
  // on load. Carried in the metadata region; never on the wire.
  headers.forEach((h, pos) => {
    if (!h.enabled && h.key.trim()) {
      lines.push(serializeDisabledRow({ kind: 'header', pos, key: h.key, value: h.value }))
    }
  })
  params.forEach((p, pos) => {
    if (!p.enabled && p.key.trim()) {
      // REQ-0124: `valueless` travels with the disabled row too, or toggling a
      // flag parameter off and back on across a save would re-add the `=`.
      lines.push(
        serializeDisabledRow({
          kind: 'param',
          pos,
          key: p.key,
          value: p.value,
          ...(p.valueless && { valueless: true })
        })
      )
    }
  })
  ;(state.formFields ?? []).forEach((f, pos) => {
    if (!f.enabled && f.key.trim()) {
      lines.push(serializeDisabledRow({ kind: 'field', pos, key: f.key, value: f.value }))
    }
  })

  // Preserved user comments — re-emitted as a block immediately after the
  // metadata region (D19, block relocation), verbatim.
  for (const comment of state.comments ?? []) lines.push(comment)

  // ── Request line ─────────────────────────────────────────────────────────
  lines.push(`${method} ${finalUrl}`)

  // Auth header echo, written first so the read-only managed entry sits
  // predictably at the top of the headers surface. The scheme owns this name:
  // any manual same-name header is dropped, not written below it (§6.4).
  if (echo.header) {
    lines.push(`${echo.header.name}: ${echo.header.value}`)
  }
  const echoHeaderName = echo.header?.name.toLowerCase()

  // User-defined headers, in author order (duplicates preserved). In multipart
  // mode we strip any `Content-Type: multipart/form-data*` row that may have
  // leaked into state — the encoder owns the header (REQ §5.2 rule 9).
  for (const h of headers) {
    if (!h.enabled || !h.key.trim()) continue
    // Skip a manual header the active scheme already owns — the echo above is
    // the sole source for that name.
    if (echoHeaderName && h.key.trim().toLowerCase() === echoHeaderName) continue
    if (
      isMultipart &&
      h.key.toLowerCase() === 'content-type' &&
      /^multipart\/form-data/i.test(h.value.trim())
    ) {
      continue
    }
    lines.push(`${h.key}: ${h.value}`)
  }

  // ── Body region ──────────────────────────────────────────────────────────
  if (isMultipart) {
    lines.push('') // blank line separating headers from the multipart block
    lines.push(...serializeMultipartSection(state.multipartParts ?? []))
  } else if (hasRawBody) {
    lines.push('') // blank line separating headers from body
    lines.push(bodyText)
  }

  return lines.join('\n') + '\n'
}

/**
 * Builds a human-readable full URL from a base URL and params array.
 * Values are NOT percent-encoded — this is for display in the URL bar only.
 * Disabled params and params with an empty key are excluded from the query string.
 * If all enabled params are empty placeholders (key='' and value=''), appends just '?'.
 */
export function computeFullUrl(baseUrl: string, params: KeyValuePair[]): string {
  const enabled = params.filter((p) => p.enabled)
  const withKey = enabled.filter((p) => p.key.trim() !== '')
  if (withKey.length > 0) {
    // REQ-0124: a value-less parameter renders as its bare key, so the field
    // gives back exactly the text that was typed into it instead of silently
    // re-adding a separator the user removed.
    const qs = withKey.map((p) => (p.valueless ? p.key : `${p.key}=${p.value}`)).join('&')
    return `${baseUrl}?${qs}`
  }
  // All enabled params are empty placeholders (e.g. bare '?' in the URL bar)
  if (enabled.length > 0 && enabled.every((p) => p.key === '' && p.value === '')) {
    return `${baseUrl}?`
  }
  return baseUrl
}

/**
 * Token-aware URL → structured-query splitter. Lives in `./query-string` (shared
 * by the renderer load path and the execution core, REQ-0081); re-exported here
 * so existing importers of `@shared/lib/http-serializer` keep working.
 */
export { splitUrlAndParams } from './query-string'
