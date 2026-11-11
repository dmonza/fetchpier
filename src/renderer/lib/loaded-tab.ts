import type { ParsedHttpFile, Tab } from '../../shared/types'
import { mapHttpRequestToEditorState } from '../components/request/request-loader'

export type LoadedTabFields = Pick<
  Tab,
  'request' | 'requestId' | 'tail' | 'normalizedOnLoad' | 'loadWarnings'
>

/**
 * The tab fields a load sets from a parsed `.http` file — shared by every site
 * that (re)loads a file into an open tab: first open, reload from disk, and an
 * external change. The editor edits the first request, so only that request's
 * load warnings and normalization mark apply; the tail is re-emitted verbatim.
 * `null` when the file holds no request.
 */
export function loadedTabFields(
  parsed: ParsedHttpFile,
  currentRequestId: string
): LoadedTabFields | null {
  const first = parsed.requests[0]
  if (!first) return null
  return {
    request: mapHttpRequestToEditorState(first),
    requestId: parsed.requestId ?? currentRequestId,
    tail: parsed.tail,
    normalizedOnLoad: first.normalizedOnLoad,
    loadWarnings: first.loadWarnings
  }
}
