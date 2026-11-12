import type {
  HttpRequest,
  RequestEditorState,
  BodyType,
  RawSubtype,
  KeyValuePair,
  DisabledRow,
  RequestSettings
} from '../../../shared/types'
import { splitUrlAndParams } from '@shared/lib/http-serializer'
import { reinterleaveDisabled } from '@shared/lib/disabled-rows'
import { splitFormBody } from '@shared/lib/query-string'

/**
 * Maps a parsed `.http` request (output of `request:parseFile`) into the
 * `RequestEditorState` consumed by the renderer. Pure — no React, no IPC,
 * no store access. UI-state hydration (active tab, response sub-tab, …)
 * lives in the caller.
 */
export function mapHttpRequestToEditorState(first: HttpRequest): RequestEditorState {
  const { baseUrl, params } = splitUrlAndParams(first.url)

  // Prefer the ordered, duplicate-capable list (authoritative); fall back to the
  // lossy record for legacy / importer-built requests that lack it.
  let pairId = 0
  const headerSource =
    first.headerList ?? Object.entries(first.headers).map(([name, value]) => ({ name, value }))
  const headerPairs: KeyValuePair[] = headerSource.map(({ name, value }) => ({
    id: `h-${pairId++}`,
    key: name,
    value,
    enabled: true
  }))
  // No default User-Agent row is inserted: the default is implicit (applied at
  // send time, shown read-only by the headers editor) and never saved, so a file
  // keeps exactly the headers its author wrote.

  const contentType = headerPairs.find((h) => h.key.toLowerCase() === 'content-type')?.value ?? ''

  let bodyType: BodyType = 'none'
  let rawSubtype: RawSubtype = first.rawSubtype ?? 'json'
  let body = first.body ?? ''
  let formFields: KeyValuePair[] = []
  const binaryFile = first.binaryFile
  const multipartParts = first.multipartParts

  if (first.bodyType === 'multipart-form' && first.multipartParts) {
    bodyType = 'multipart-form'
    body = ''
  } else if (first.bodyType === 'binary' && first.binaryFile) {
    bodyType = 'binary'
    body = ''
  } else if (first.invalidBinaryRef !== undefined) {
    // The author attached a file whose reference is not valid: binary mode with
    // no file, holding the reference (advisory, kept on save, send refused).
    bodyType = 'binary'
    body = ''
  } else if (first.body) {
    const ctLower = contentType.toLowerCase()
    if (ctLower.includes('application/x-www-form-urlencoded')) {
      bodyType = 'x-www-form-urlencoded'
      // The shared form decoder (token-aware, `+` → space, a malformed escape
      // keeps its author bytes) — the same one history and the core use.
      formFields = splitFormBody(first.body)
      body = ''
    } else {
      bodyType = 'raw'
      if (!first.rawSubtype) {
        if (ctLower.includes('application/json')) rawSubtype = 'json'
        else if (ctLower.includes('xml')) rawSubtype = 'xml'
        else if (ctLower.includes('javascript')) rawSubtype = 'javascript'
        else if (ctLower.includes('text/html') || ctLower.includes('application/html'))
          rawSubtype = 'html'
        else if (ctLower.includes('text/')) rawSubtype = 'text'
      }
    }
  }

  const loadedSettings: RequestSettings = { ...(first.settings ?? {}) }
  if (first.disableCookieJar === true && !loadedSettings.disableCookieJar) {
    loadedSettings.disableCookieJar = { inherit: false, value: true }
  }

  // Re-interleave disabled rows back into their author positions (the wire-bound
  // lists above hold only enabled rows). bodyType/Content-Type inference above
  // intentionally ran on the enabled lists.
  const disabled = first.disabledRows ?? []
  let dId = 0
  const mk = (r: DisabledRow): KeyValuePair => ({
    id: `d-${dId++}`,
    key: r.key,
    value: r.value,
    enabled: false,
    // REQ-0124: carry the value-less mark across the directive → row boundary, so
    // re-enabling a disabled flag parameter restores it as a flag.
    ...(r.valueless && { valueless: true })
  })
  const mergedHeaders = reinterleaveDisabled(
    headerPairs,
    disabled.filter((d) => d.kind === 'header'),
    mk
  )
  const mergedParams = reinterleaveDisabled(
    params,
    disabled.filter((d) => d.kind === 'param'),
    mk
  )
  const mergedFields = reinterleaveDisabled(
    formFields,
    disabled.filter((d) => d.kind === 'field'),
    mk
  )

  return {
    method: first.method,
    url: baseUrl,
    params: mergedParams,
    headers: mergedHeaders,
    bodyType,
    rawSubtype,
    body,
    formFields: mergedFields,
    auth: first.auth ?? { type: 'none' },
    preRequestScript: first.preRequestScript ?? '',
    postResponseScript: first.postResponseScript ?? '',
    settings: loadedSettings,
    comments: first.comments,
    binaryFile,
    ...(first.invalidBinaryRef !== undefined && !binaryFile
      ? { invalidBinaryRef: first.invalidBinaryRef }
      : {}),
    multipartParts
  }
}
