// REQ case-insensitive tree name uniqueness — inline validation is a rendered
// verdict from the core, never a renderer-side rule (CA-09). These cases pin
// the state machine: debounce, taken/available mapping, cancel-on-new-input
// (stale verdicts never land), and fail-open on a check error.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryNameAvailability, type NameAvailability } from './name-availability'
import type { NameCheckInput, NameCheckResult } from '../../shared/types'

const INPUT: NameCheckInput = { kind: 'entry', parentPath: '/ws/requests', name: 'Get-Users' }

let states: NameAvailability[]
const emit = (s: NameAvailability): void => {
  states.push(s)
}

beforeEach(() => {
  vi.useFakeTimers()
  states = []
})
afterEach(() => {
  vi.useRealTimers()
})

async function settle(): Promise<void> {
  await vi.runAllTimersAsync()
}

describe('queryNameAvailability', () => {
  it('emits idle without any round-trip when there is nothing to check', () => {
    const check = vi.fn()
    queryNameAvailability(null, emit, check)
    expect(states).toEqual(['idle'])
    expect(check).not.toHaveBeenCalled()
  })

  it('emits checking immediately, then available from the core verdict', async () => {
    const check = vi.fn().mockResolvedValue({ available: true } satisfies NameCheckResult)
    queryNameAvailability(INPUT, emit, check)
    expect(states).toEqual(['checking'])
    await settle()
    expect(states).toEqual(['checking', 'available'])
    expect(check).toHaveBeenCalledWith(INPUT)
  })

  it('emits taken when the core reports the name occupied', async () => {
    const check = vi.fn().mockResolvedValue({
      available: false,
      conflict: 'request'
    } satisfies NameCheckResult)
    queryNameAvailability(INPUT, emit, check)
    await settle()
    expect(states).toEqual(['checking', 'taken'])
  })

  it('debounces: cancelling before the delay fires never calls the check', async () => {
    const check = vi.fn().mockResolvedValue({ available: true })
    const cancel = queryNameAvailability(INPUT, emit, check)
    cancel()
    await settle()
    expect(check).not.toHaveBeenCalled()
    expect(states).toEqual(['checking'])
  })

  it('a verdict landing after cancel is dropped (stale responses never emit)', async () => {
    let resolve!: (r: NameCheckResult) => void
    const check = vi.fn().mockReturnValue(
      new Promise<NameCheckResult>((r) => {
        resolve = r
      })
    )
    const cancel = queryNameAvailability(INPUT, emit, check)
    await vi.advanceTimersByTimeAsync(200) // past the debounce: check in flight
    expect(check).toHaveBeenCalled()
    cancel()
    resolve({ available: false, conflict: 'request' })
    await Promise.resolve()
    expect(states).toEqual(['checking'])
  })

  it('fails open: a check error resolves to idle, never blocking submit', async () => {
    const check = vi.fn().mockRejectedValue(new Error('NO_ACTIVE_WORKSPACE'))
    queryNameAvailability(INPUT, emit, check)
    await settle()
    expect(states).toEqual(['checking', 'idle'])
  })
})
