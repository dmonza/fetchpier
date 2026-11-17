import { useEffect } from 'react'
import { useHistoryChipsStore } from '../../stores/historyChips'
import { useOpenTabChips } from './useOpenTabChips'

/**
 * Main window, while the Activity panel is detached (ISS-0073): the docked
 * `HistoryList` is unmounted, so this keeps the request chips in step with the
 * tabs, publishes every complete set to the popout through main, and toggles
 * the chips the popout sends back. The chips live in this window's store, so
 * docking back finds the selection made in the popout. Renders nothing.
 *
 * Imported statically by `ActivityPanelHost`: it pulls in no editor code (the
 * renderer cold-path rule is about the CodeMirror chunk), and a lazy chunk
 * failure would have no visible place to report itself.
 */
export function PopoutChipsPublisher(): null {
  const complete = useOpenTabChips(true)
  const chips = useHistoryChipsStore((s) => s.chips)
  const toggleChip = useHistoryChipsStore((s) => s.toggleChip)

  useEffect(() => window.api.activityPanel.onChipToggle(toggleChip), [toggleChip])

  useEffect(() => {
    if (!complete) return
    window.api.activityPanel
      .publishChips(chips)
      .then((taken) => {
        if (!taken) console.error('[activity-panel] The chip set was not taken')
      })
      .catch((err: unknown) => console.error('[activity-panel] Failed to publish the chips:', err))
  }, [complete, chips])

  return null
}
