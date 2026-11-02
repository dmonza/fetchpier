import type { NameCheckInput, NameCheckResult } from '../../shared/types'

/**
 * Inline name-validation state (REQ case-insensitive tree name uniqueness):
 * the renderer computes no name rule — the verdict comes from the core over
 * IPC. Only `'taken'` blocks submit; `'checking'` never does (the mutating
 * operation is the final gate), and a failed check resolves to `'idle'` so the
 * inline layer cannot block on its own failure.
 */
export type NameAvailability = 'idle' | 'checking' | 'available' | 'taken'

const DEBOUNCE_MS = 150

/**
 * Start one debounced availability query for `input`, emitting state changes
 * through `emit`. Returns a cancel function: once called, nothing is emitted
 * anymore (the caller re-queries on the next input, so a stale verdict never
 * lands). `null` input emits `'idle'` and needs no round-trip.
 */
export function queryNameAvailability(
  input: NameCheckInput | null,
  emit: (state: NameAvailability) => void,
  check: (input: NameCheckInput) => Promise<NameCheckResult> = (i) =>
    window.api.filesystem.checkName(i)
): () => void {
  let cancelled = false
  if (!input) {
    emit('idle')
    return () => {
      cancelled = true
    }
  }
  emit('checking')
  const timer = window.setTimeout(() => {
    check(input).then(
      (result) => {
        if (!cancelled) emit(result.available ? 'available' : 'taken')
      },
      () => {
        if (!cancelled) emit('idle')
      }
    )
  }, DEBOUNCE_MS)
  return () => {
    cancelled = true
    window.clearTimeout(timer)
  }
}
