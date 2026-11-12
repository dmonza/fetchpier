import type {
  BodyType,
  HistoryEntry,
  KeyValuePair,
  RawSubtype,
  RequestEditorState
} from '../../../shared/types'
import { splitFormBody, splitUrlAndParams } from '@shared/lib/query-string'

/**
 * Editor states rebuilt from an activity-log entry, for the history surfaces:
 * the read-only "Open" tab and "Repeat". Pure — no React, no store access.
 *
 * The entry's `request.url` is the recorded template URL (`# @path-raw`), query
 * included. It is split into base + parameters like any URL the editor opens,
 * so the Params grid shows them and a send assembles them as usual. A run
 * recorded before the query was kept carries only the base.
 */

/** The read-only tab's request: body mode inferred from the recorded `Content-Type`. */
export function historyViewRequest(entry: HistoryEntry): RequestEditorState {
  const { method, url, headers, body } = entry.request
  const { baseUrl, params } = splitUrlAndParams(url)

  const contentType =
    Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? ''
  const ct = contentType.toLowerCase()

  let bodyType: BodyType = 'none'
  let rawSubtype: RawSubtype = 'json'
  let resolvedBody = body ?? ''
  let formFields: KeyValuePair[] = []

  if (ct.includes('application/x-www-form-urlencoded')) {
    bodyType = 'x-www-form-urlencoded'
    if (entry.request.formFields?.length) {
      let fieldId = 0
      formFields = entry.request.formFields.map((f) => ({
        id: `f-${fieldId++}`,
        key: f.key,
        value: f.value,
        enabled: f.enabled ?? true
      }))
    } else if (body) {
      // The editor's own form decoder: a malformed escape keeps its raw text.
      formFields = splitFormBody(body)
    }
    resolvedBody = ''
  } else if (body) {
    bodyType = 'raw'
    if (ct.includes('application/json')) rawSubtype = 'json'
    else if (ct.includes('xml')) rawSubtype = 'xml'
    else if (ct.includes('javascript')) rawSubtype = 'javascript'
    else if (ct.includes('text/html') || ct.includes('application/html')) rawSubtype = 'html'
    else if (ct.includes('text/')) rawSubtype = 'text'
  }

  return {
    method,
    url: baseUrl,
    params,
    headers: headerRows(headers),
    bodyType,
    rawSubtype,
    body: resolvedBody,
    formFields,
    auth: { type: 'none' },
    preRequestScript: entry.request.preRequestScript ?? '',
    postResponseScript: entry.request.postResponseScript ?? '',
    settings: {}
  }
}

/** The editable tab "Repeat" opens when the source file is not already open. */
export function historyRepeatRequest(entry: HistoryEntry): RequestEditorState {
  const { method, url, headers, body } = entry.request
  const { baseUrl, params } = splitUrlAndParams(url)
  return {
    method,
    url: baseUrl,
    params,
    headers: headerRows(headers),
    bodyType: body ? 'raw' : 'none',
    rawSubtype: 'json',
    body: body ?? '',
    formFields: [],
    auth: { type: 'none' },
    preRequestScript: entry.request.preRequestScript ?? '',
    postResponseScript: entry.request.postResponseScript ?? '',
    settings: {}
  }
}

function headerRows(headers: Record<string, string>): KeyValuePair[] {
  return Object.entries(headers).map(([key, value], i) => ({
    id: `h-${i}`,
    key,
    value,
    enabled: true
  }))
}
