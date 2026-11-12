/**
 * The engine's failure reason for a cancelled send (`client.ts`). It is not
 * localized there, like every other transport reason, so the history keeps it.
 */
const ENGINE_CANCELLED = 'Request cancelled'

/**
 * What the request tab shows for a send's in-band failure: the localized
 * cancellation when the user cancelled this send and the engine reports it as
 * cancelled, the engine's reason otherwise, and nothing when there is none.
 */
export function labelSendError(
  error: string | null | undefined,
  userCancelled: boolean,
  cancelledLabel: string
): string | null {
  if (!error) return null
  return userCancelled && error === ENGINE_CANCELLED ? cancelledLabel : error
}
