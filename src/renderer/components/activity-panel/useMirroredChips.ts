import { useEffect } from 'react'
import { useHistoryChipsStore } from '../../stores/historyChips'

/**
 * Popout: show the main window's History chip set (ISS-0073). Listens for the
 * sets the owner publishes, then pulls the last one main kept — a set
 * published before this renderer listened is not re-sent. A broadcast that
 * lands before the pull answers is newer, so the pull does not override it.
 *
 * Returns whether a set has arrived (always `false` when disabled).
 */
export function useMirroredChips(enabled: boolean): boolean {
  const applyMirror = useHistoryChipsStore((s) => s.applyMirror)
  const mirrored = useHistoryChipsStore((s) => s.mirrored)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let broadcastSeen = false
    const unsubscribe = window.api.activityPanel.onChipsChanged((chips) => {
      broadcastSeen = true
      applyMirror(chips)
    })
    window.api.activityPanel
      .getChips()
      .then((chips) => {
        if (!cancelled && !broadcastSeen && chips) applyMirror(chips)
      })
      .catch((err: unknown) => console.error('[HistoryList] Failed to read the chip set:', err))
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [enabled, applyMirror])

  return enabled && mirrored
}
