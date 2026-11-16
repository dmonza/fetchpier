import type { HistoryRowActionContext } from './history-row-actions'

/**
 * Main window: run every History row action the Activity popout forwards
 * (ISS-0164), with the context read when it runs. The runner is loaded on the
 * first forwarded action, so subscribing from `AppLayout` adds nothing to the
 * renderer cold path. Returns the unsubscribe.
 */
export function subscribeToForwardedRowActions(
  getContext: () => HistoryRowActionContext
): () => void {
  return window.api.activityPanel.onRowAction((action) => {
    import('./history-row-actions')
      .then(({ runHistoryRowAction }) => runHistoryRowAction(action, getContext()))
      .catch((err: unknown) => console.error('[activity-panel] Failed to run a row action:', err))
  })
}
