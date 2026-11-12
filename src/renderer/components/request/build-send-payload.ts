import type { HeaderEntry, HttpRequest, RequestEditorState } from '../../../shared/types'
import { RAW_SUBTYPE_CONTENT_TYPE } from '../../../shared/types'
import { authEcho, isAuthQueryParam } from '@shared/lib/auth-echo'

/**
 * Builds the `HttpRequest` payload handed to the execution core for a send.
 * Pure — no React, no IPC, no store access (the caller passes the resolved
 * environment variables in).
 *
 * REQ-0081: the renderer performs **no** percent-encoding of query data. The
 * structured query (`state.params`) crosses the boundary verbatim — `{{tokens}}`
 * stay unencoded so the core resolves them and then contextually encodes the
 * resolved values (gated by `encodeUrl`). `url` carries the base only; the core
 * assembles the final URL. Form fields likewise cross as structured data and are
 * encoded core-side after resolution.
 *
 * Per-request settings overrides cross as the editor holds them — the engine
 * resolves them against the workspace defaults and reports what it applied
 * (`resolvedSettings`). The cookie-jar override travels inside `settings` like
 * every other one; the top-level `disableCookieJar` flag is the parser's
 * channel for the `# @disable-cookie-jar` marker, which the loader has already
 * folded into `settings`.
 */
export function buildHttpRequestPayload(
  state: RequestEditorState,
  variables: Record<string, string>
): HttpRequest {
  const { method, url, headers, params, body, bodyType, rawSubtype, auth } = state

  // An active auth scheme owns its header / query-parameter name — a manual
  // same-name entry is ignored so `applyAuth` (core) is the sole source and
  // nothing is double-applied (REQ-0083 §6.4, owner decision).
  const echo = authEcho(auth)
  const echoHeaderName = echo.header?.name.trim().toLowerCase()
  const echoParamName = echo.query?.key

  // Build the ordered, duplicate-capable header list from enabled pairs (the
  // authoritative wire representation), plus the lossy record fallback. An
  // active scheme's echo name is dropped — `applyAuth` is the sole source.
  const headerList: HeaderEntry[] = []
  const headersRecord: Record<string, string> = {}
  const pushHeader = (name: string, value: string): void => {
    headerList.push({ name, value })
    headersRecord[name] = value
  }
  for (const h of headers) {
    if (!h.enabled || !h.key) continue
    if (echoHeaderName && h.key.trim().toLowerCase() === echoHeaderName) continue
    pushHeader(h.key, h.value)
  }

  // Add Content-Type for body types that need it. For raw bodies, pick the MIME
  // from the subtype unless the user set one explicitly.
  const hasExplicitContentType = headerList.some((h) => h.name.toLowerCase() === 'content-type')
  if (bodyType === 'raw' && !hasExplicitContentType) {
    pushHeader('Content-Type', RAW_SUBTYPE_CONTENT_TYPE[rawSubtype])
  }

  // x-www-form-urlencoded: pass formFields to the core for variable resolution +
  // encoding (the body string is built there, after resolution).
  let requestBody: string | undefined
  if (bodyType === 'x-www-form-urlencoded') {
    const hasFields = state.formFields.some((f) => f.enabled && f.key)
    if (hasFields && !hasExplicitContentType) {
      pushHeader('Content-Type', 'application/x-www-form-urlencoded')
    }
    requestBody = undefined
  } else {
    requestBody = bodyType !== 'none' && body ? body : undefined
  }

  // Header names are case-insensitive; query names are not (FMT-16).
  const cleanParams = echoParamName
    ? params.filter((p) => !isAuthQueryParam(p.key, echoParamName))
    : params

  return {
    method,
    url,
    params: cleanParams,
    headers: headersRecord,
    headerList,
    body: bodyType === 'binary' || bodyType === 'multipart-form' ? undefined : requestBody,
    formFields: bodyType === 'x-www-form-urlencoded' ? state.formFields : undefined,
    variables,
    auth,
    preRequestScript: state.preRequestScript || undefined,
    postResponseScript: state.postResponseScript || undefined,
    settings: state.settings,
    bodyType,
    binaryFile: bodyType === 'binary' ? state.binaryFile : undefined,
    // A reference the file held that is not valid, while no file replaces it:
    // the engine refuses the request instead of sending it without the file.
    ...(bodyType === 'binary' && !state.binaryFile?.ref && state.invalidBinaryRef !== undefined
      ? { invalidBinaryRef: state.invalidBinaryRef }
      : {}),
    multipartParts: bodyType === 'multipart-form' ? state.multipartParts : undefined
  }
}
