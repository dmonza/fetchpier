/**
 * LazyBoundary (PLAN-0121)
 *
 * The shared wrapper for every surface that was code-split off the renderer cold
 * path (the editor/response split, the activity panel, the command palette, the
 * schema-import dialog). It combines:
 *
 *  1. A `Suspense` boundary whose fallback is, by default, a minimal same-size
 *     empty panel — matching the existing `ScriptsEditor` lazy pattern (no
 *     spinner; local chunks resolve near-instantly, so a spinner would flash).
 *  2. A class error boundary that **contains** a chunk-load failure: instead of
 *     letting the thrown error unmount the whole renderer, it renders a small,
 *     retryable inline message in place of the failed surface. The rest of the
 *     app keeps working.
 *
 * Retry resets the boundary and re-renders the subtree. For a permanently broken
 * local chunk the error re-surfaces (the contained, non-crashing state is the
 * guarantee); for a transient failure the subtree recovers.
 */
import { Component, Suspense, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

/** Minimal, same-size empty fallback. */
const DEFAULT_PENDING = <div className="h-full w-full" />

function LoadErrorFallback({ onRetry }: { onRetry: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-muted-foreground">
      <span>{t('common.loadFailed')}</span>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-md border border-border px-3 py-1 text-foreground transition-colors hover:bg-accent"
      >
        {t('common.retry')}
      </button>
    </div>
  )
}

interface ErrorBoundaryProps {
  children: ReactNode
  renderError: (onRetry: () => void) => ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
}

class LoadErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true }
  }

  private handleRetry = (): void => {
    this.setState({ hasError: false })
  }

  render(): ReactNode {
    if (this.state.hasError) return this.props.renderError(this.handleRetry)
    return this.props.children
  }
}

export interface LazyBoundaryProps {
  children: ReactNode
  /** Fallback while the lazy chunk loads. Defaults to a minimal empty panel. */
  pending?: ReactNode
}

export function LazyBoundary({
  children,
  pending = DEFAULT_PENDING
}: LazyBoundaryProps): React.JSX.Element {
  return (
    <LoadErrorBoundary renderError={(onRetry) => <LoadErrorFallback onRetry={onRetry} />}>
      <Suspense fallback={pending}>{children}</Suspense>
    </LoadErrorBoundary>
  )
}
