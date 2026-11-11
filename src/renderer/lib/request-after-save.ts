import type { RequestEditorState } from '../../shared/types'

/**
 * The in-memory request after a save, mirroring what the serializer wrote: it
 * drops a malformed query parameter and a multipart part carrying a parse error
 * (neither can be written back faithfully). Without this the tab kept them and
 * stayed modified after a successful save. Returns the same object when there
 * is nothing to drop.
 */
export function requestAfterSave(request: RequestEditorState): RequestEditorState {
  const malformedParam = request.params.some((p) => p.malformed)
  const brokenPart = request.multipartParts?.some(
    (p) => (p as { parseError?: string }).parseError !== undefined
  )
  if (!malformedParam && !brokenPart) return request
  return {
    ...request,
    ...(malformedParam ? { params: request.params.filter((p) => !p.malformed) } : {}),
    ...(brokenPart
      ? {
          multipartParts: request.multipartParts!.filter(
            (p) => (p as { parseError?: string }).parseError === undefined
          )
        }
      : {})
  }
}
