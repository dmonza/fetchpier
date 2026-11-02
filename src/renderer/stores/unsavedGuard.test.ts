import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_REQUEST_STATE } from '../../shared/types'
import type { Tab } from '../../shared/types'
import { cleanHashOf } from '../lib/tab-dirty'

let useUnsavedGuardStore: typeof import('./unsavedGuard').useUnsavedGuardStore
let guardDiscard: typeof import('./unsavedGuard').guardDiscard

beforeEach(async () => {
  vi.resetModules()
  const mod = await import('./unsavedGuard')
  useUnsavedGuardStore = mod.useUnsavedGuardStore
  guardDiscard = mod.guardDiscard
})

afterEach(() => {
  vi.restoreAllMocks()
})

function makeTab(overrides: Partial<Tab> = {}): Tab {
  const request = overrides.request ?? { ...DEFAULT_REQUEST_STATE }
  const base: Tab = {
    id: '1',
    title: 'T',
    filePath: '/ws/a.http',
    isDirty: false,
    request,
    response: null,
    isLoading: false,
    error: null,
    requestId: 'req-1',
    mode: 'permanent',
    ...overrides
  }
  return base
}

const cleanTab = (id: string): Tab => {
  const t = makeTab({ id, requestId: `req-${id}` })
  return { ...t, cleanHash: cleanHashOf(t) }
}
const dirtyTab = (id: string): Tab =>
  makeTab({ id, requestId: `req-${id}`, cleanHash: 'stale-baseline' })

describe('guardDiscard', () => {
  it('runs proceed immediately and opens no prompt when nothing is dirty', async () => {
    const proceed = vi.fn().mockResolvedValue(undefined)
    await guardDiscard([cleanTab('a'), cleanTab('b')], proceed)
    expect(proceed).toHaveBeenCalledTimes(1)
    expect(useUnsavedGuardStore.getState().pending).toBeNull()
  })

  it('opens the prompt with only the dirty tabs and defers proceed', async () => {
    const proceed = vi.fn().mockResolvedValue(undefined)
    await guardDiscard([cleanTab('a'), dirtyTab('b'), dirtyTab('c')], proceed)
    expect(proceed).not.toHaveBeenCalled()
    const pending = useUnsavedGuardStore.getState().pending
    expect(pending).not.toBeNull()
    expect(pending!.tabs.map((t) => t.id)).toEqual(['b', 'c'])
    expect(pending!.onProceed).toBe(proceed)
  })

  it('never guards read-only tabs', async () => {
    const proceed = vi.fn().mockResolvedValue(undefined)
    const ro = makeTab({ id: 'r', isReadOnly: true, cleanHash: 'stale' })
    await guardDiscard([ro], proceed)
    expect(proceed).toHaveBeenCalledTimes(1)
    expect(useUnsavedGuardStore.getState().pending).toBeNull()
  })

  it('clear() resets the pending guard', () => {
    useUnsavedGuardStore.getState().request([dirtyTab('a')], vi.fn())
    expect(useUnsavedGuardStore.getState().pending).not.toBeNull()
    useUnsavedGuardStore.getState().clear()
    expect(useUnsavedGuardStore.getState().pending).toBeNull()
  })
})
