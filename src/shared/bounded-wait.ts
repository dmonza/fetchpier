/**
 * How long the interface waits for the main process to report that its deferred
 * registration finished, before proceeding anyway.
 *
 * The projected margin is a few milliseconds — the deferred registration and
 * the renderer's own startup run concurrently and finish together — so this is
 * three orders of magnitude above ordinary operation. It is not a latency
 * budget; it is the point at which "still loading" stops being a credible
 * explanation and the operation should be allowed to fail visibly instead.
 */
export const HANDLERS_READY_BOUND_MS = 10_000

/**
 * Wait for `pending`, but never longer than `boundMs`.
 *
 * Resolves either way, and never rejects: callers gate their own work on this,
 * so a rejection would turn one failed registration into an unhandled rejection
 * at every call site. A rejected `pending` counts as settled — whatever failed
 * has already been reported by whoever owns it.
 *
 * `onExpiry` runs exactly once, and only when the bound is what ended the wait.
 */
export function boundedWait(
  pending: Promise<unknown>,
  boundMs: number,
  onExpiry: () => void
): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      onExpiry()
      resolve()
    }, boundMs)

    const settle = (): void => {
      clearTimeout(timer)
      resolve()
    }
    pending.then(settle, settle)
  })
}
