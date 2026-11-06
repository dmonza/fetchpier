import type {
  ExecutedRequestResult,
  HistoryEntry,
  HttpRequest,
  HttpResponse
} from '../../shared/types'

/**
 * The response the viewer shows: as received when the send returned it that way
 * (the user turned off "hide secrets in responses"), otherwise the masked one.
 */
export function viewerResponse(result: ExecutedRequestResult): HttpResponse | undefined {
  return result.unmaskedResponse ?? result.response
}

/**
 * The activity-log entry for a send. It always records the masked `response` —
 * never `unmaskedResponse` — so a secret the viewer may show never reaches disk.
 * `request` keeps the editor-side shape (with `{{variables}}`) for replay;
 * `wireRequest` is the wire snapshot the history writer renders.
 */
export function buildHistoryEntry(args: {
  id: string
  timestamp: string
  request: HttpRequest
  result: ExecutedRequestResult
  sourceFile: string | null
  requestId?: string
}): HistoryEntry | undefined {
  const { result } = args
  if (!result.response) return undefined
  return {
    id: args.id,
    timestamp: args.timestamp,
    request: args.request,
    wireRequest: result.request,
    response: result.response,
    sourceFile: args.sourceFile,
    requestId: args.requestId,
    scriptResults: result.scriptResults,
    resolvedSettings: result.resolvedSettings,
    cookies: result.cookies,
    remoteIp: result.remoteIp
  }
}
