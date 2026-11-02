/**
 * The bound behind the preload's readiness gate.
 *
 * Every operation the interface requests waits for the main process to report
 * that its deferred registration finished. That wait has to end even when the
 * report never comes: an unbounded one turns a load failure into an interface
 * that is fully drawn, looks functional, and silently serves nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { boundedWait } from './bounded-wait'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('boundedWait', () => {
  it('resolves as soon as the wait settles, well inside the bound', async () => {
    const onExpiry = vi.fn()
    const settled = boundedWait(Promise.resolve('ready'), 10_000, onExpiry)

    await expect(settled).resolves.toBeUndefined()
    expect(onExpiry).not.toHaveBeenCalled()
  })

  it('does not report expiry after the wait already settled', async () => {
    // The bound's timer must be cancelled, or a successful startup logs a
    // failure ten seconds later.
    const onExpiry = vi.fn()
    await boundedWait(Promise.resolve('ready'), 10_000, onExpiry)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(onExpiry).not.toHaveBeenCalled()
  })

  it('gives up once the bound elapses, and says so', async () => {
    const onExpiry = vi.fn()
    let settled = false
    void boundedWait(new Promise(() => {}), 10_000, onExpiry).then(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(9_999)
    expect(settled).toBe(false)
    expect(onExpiry).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(true)
    expect(onExpiry).toHaveBeenCalledTimes(1)
  })

  it('treats a rejected wait as settled rather than propagating', async () => {
    // Callers gate their own work on this; a rejection here would turn one
    // failed registration into an unhandled rejection on every call site.
    const onExpiry = vi.fn()

    await expect(
      boundedWait(Promise.reject(new Error('registration blew up')), 10_000, onExpiry)
    ).resolves.toBeUndefined()
    expect(onExpiry).not.toHaveBeenCalled()
  })

  it('reports expiry once however many callers share the same wait', async () => {
    // The gate is created once and awaited by every operation, so a per-caller
    // report would put one line in the log for each of them.
    const onExpiry = vi.fn()
    const gate = boundedWait(new Promise(() => {}), 10_000, onExpiry)

    await vi.advanceTimersByTimeAsync(10_000)
    await Promise.all([gate, gate, gate])

    expect(onExpiry).toHaveBeenCalledTimes(1)
  })
})
