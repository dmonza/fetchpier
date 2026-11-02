import { lazy, useCallback, useEffect, useMemo, useRef } from 'react'
import { computeDefaultHeight, useActivityPanelStore } from '../../stores/activityPanel'
import { LazyBoundary } from '../ui/LazyBoundary'

// Code-split off the renderer cold path (PLAN-0121): the activity panel is opt-in
// and closed at launch, yet its run-detail view statically pulls the CodeMirror
// chunk. Deferring it here cuts the third (and last) eager entry → CodeMirror edge.
const ActivityPanel = lazy(() =>
  import('./ActivityPanel').then((m) => ({ default: m.ActivityPanel }))
)

/**
 * Docked host for the activity panel. Mounted once at the top of <AppLayout/>.
 * Renders nothing unless the panel is open AND not detached.
 *
 * The panel is positioned as an absolute overlay anchored to the bottom of the
 * main content area — it covers the editor/response split but sits BELOW the
 * status bar, which retains its toggle affordance.
 */
export function ActivityPanelHost(): React.JSX.Element | null {
  const isOpen = useActivityPanelStore((s) => s.isOpen)
  const isDetached = useActivityPanelStore((s) => s.isDetached)
  const heightPx = useActivityPanelStore((s) => s.heightPx)
  const setHeight = useActivityPanelStore((s) => s.setHeight)

  const isVisible = isOpen && !isDetached
  const effectiveHeight = useMemo(() => {
    if (!isVisible) return 0
    if (heightPx && Number.isFinite(heightPx)) return heightPx
    return computeDefaultHeight(typeof window !== 'undefined' ? window.innerHeight : 800)
  }, [isVisible, heightPx])

  const dragState = useRef<{ startY: number; startHeight: number } | null>(null)

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      dragState.current = { startY: e.clientY, startHeight: effectiveHeight }

      const onMove = (moveEvent: PointerEvent): void => {
        if (!dragState.current) return
        const dy = dragState.current.startY - moveEvent.clientY
        setHeight(dragState.current.startHeight + dy, { persist: false })
      }

      const onUp = (upEvent: PointerEvent): void => {
        if (!dragState.current) {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointercancel', onCancel)
          return
        }
        const dy = dragState.current.startY - upEvent.clientY
        // Final commit triggers the debounced persist.
        setHeight(dragState.current.startHeight + dy)
        dragState.current = null
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointercancel', onCancel)
      }

      // A cancelled drag (pointer capture revoked by the OS/browser) must
      // release the listener exactly like a normal release, without
      // committing a height from whatever coordinates the cancellation
      // carries.
      const onCancel = (): void => {
        dragState.current = null
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointercancel', onCancel)
      }

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp, { once: true })
      window.addEventListener('pointercancel', onCancel, { once: true })
    },
    [effectiveHeight, setHeight]
  )

  // Re-clamp the height on window resize so a smaller viewport still leaves
  // room for the editor + status bar.
  useEffect(() => {
    if (!isVisible) return
    const onResize = (): void => {
      const current = useActivityPanelStore.getState().heightPx
      if (current === null) return
      setHeight(current, { persist: false })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [isVisible, setHeight])

  if (!isVisible) return null

  return (
    <div
      data-testid="activity-panel-host"
      className="pointer-events-auto absolute inset-x-0 z-30 flex flex-col border-t border-border bg-background shadow-[0_-4px_12px_rgba(0,0,0,0.06)] dark:shadow-[0_-4px_12px_rgba(0,0,0,0.3)]"
      style={{ height: effectiveHeight, bottom: 0 }}
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        onPointerDown={handlePointerDown}
        className="group absolute -top-1 left-0 right-0 z-10 h-2 cursor-ns-resize"
      >
        <div className="mx-auto mt-[3px] h-[2px] w-12 rounded-full bg-border transition-colors group-hover:bg-primary/60" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <LazyBoundary>
          <ActivityPanel mode="docked" />
        </LazyBoundary>
      </div>
    </div>
  )
}
