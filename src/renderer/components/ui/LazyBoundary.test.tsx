// PLAN-0121 — LazyBoundary: the shared Suspense + recoverable-error wrapper for
// every lazy-loaded surface that left the renderer cold path.
//   CA-02: a minimal fallback is shown while the chunk is pending.
//   CA-05: a rejected chunk load surfaces a contained, retryable inline error —
//          the rest of the app keeps rendering (no crash, no permanent blank).

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { act, lazy, type ComponentType } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// React 19 requires this flag for act(...) to flush updates.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('react-i18next', () => ({
  useTranslation: (): { t: (k: string) => string } => ({ t: (key: string) => key })
}))

import { LazyBoundary } from './LazyBoundary'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

async function flush(): Promise<void> {
  // Let the lazy promise settle and React re-render through Suspense / the
  // error boundary.
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('LazyBoundary', () => {
  it('shows the pending fallback while the lazy chunk has not resolved (CA-02)', async () => {
    const Never = lazy(() => new Promise<{ default: ComponentType }>(() => {}))
    await act(async () => {
      root.render(
        <LazyBoundary pending={<div data-testid="pending" />}>
          <Never />
        </LazyBoundary>
      )
    })
    expect(container.querySelector('[data-testid="pending"]')).not.toBeNull()
  })

  it('defaults to a minimal same-size empty panel when no pending prop is given (CA-02)', async () => {
    const Never = lazy(() => new Promise<{ default: ComponentType }>(() => {}))
    await act(async () => {
      root.render(
        <LazyBoundary>
          <Never />
        </LazyBoundary>
      )
    })
    const fallback = container.firstElementChild as HTMLElement | null
    expect(fallback).not.toBeNull()
    // No spinner / text — just an empty full-size panel.
    expect(fallback?.textContent).toBe('')
  })

  it('contains a rejected chunk load as a retryable inline error and keeps siblings usable (CA-05)', async () => {
    // React logs the caught error; silence it for a clean run.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const Boom = lazy(() => Promise.reject(new Error('chunk load failed')))

    await act(async () => {
      root.render(
        <div>
          <span data-testid="sibling">still here</span>
          <LazyBoundary>
            <Boom />
          </LazyBoundary>
        </div>
      )
    })
    await flush()

    // The error is contained: the inline message + retry affordance render,
    // the app did not crash, and the sibling outside the boundary is intact.
    expect(container.textContent).toContain('common.loadFailed')
    const retry = container.querySelector('button')
    expect(retry).not.toBeNull()
    expect(container.querySelector('[data-testid="sibling"]')?.textContent).toBe('still here')
  })

  it('retrying re-renders the boundary without throwing (CA-05)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const Boom = lazy(() => Promise.reject(new Error('chunk load failed')))

    await act(async () => {
      root.render(
        <LazyBoundary>
          <Boom />
        </LazyBoundary>
      )
    })
    await flush()

    const retry = container.querySelector('button') as HTMLButtonElement
    expect(retry).not.toBeNull()
    // Clicking retry must not crash the renderer (it re-attempts the subtree).
    await act(async () => {
      retry.click()
    })
    await flush()
    // The boundary is still mounted and usable (button still present, no throw).
    expect(container.querySelector('button')).not.toBeNull()
  })
})
