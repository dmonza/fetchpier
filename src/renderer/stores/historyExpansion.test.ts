import { beforeEach, describe, expect, it } from 'vitest'
import { useHistoryExpansionStore } from './historyExpansion'
import type { ActivityLogFile } from '../../shared/lib/activity-log'

const FILE: ActivityLogFile = {
  header: [],
  requestRaw: 'GET / HTTP/1.1\n\n',
  responseRaw: 'HTTP/1.1 200 OK\n\n',
  tailBlocks: []
}

describe('historyExpansion store', () => {
  beforeEach(() => {
    useHistoryExpansionStore.getState().reset()
  })

  it('toggles expansion state for a single id', () => {
    const s = useHistoryExpansionStore.getState()
    expect(s.isExpanded('a')).toBe(false)
    s.toggle('a')
    expect(useHistoryExpansionStore.getState().isExpanded('a')).toBe(true)
    s.toggle('a')
    expect(useHistoryExpansionStore.getState().isExpanded('a')).toBe(false)
  })

  it('expand and collapse are idempotent', () => {
    const s = useHistoryExpansionStore.getState()
    s.expand('a')
    s.expand('a')
    expect(useHistoryExpansionStore.getState().expandedIds.size).toBe(1)
    s.collapse('a')
    s.collapse('a')
    expect(useHistoryExpansionStore.getState().expandedIds.size).toBe(0)
  })

  it('caches a parsed file and clears any prior error for the same id', () => {
    const s = useHistoryExpansionStore.getState()
    s.setError('a', 'boom')
    s.setParsed('a', FILE)
    const next = useHistoryExpansionStore.getState()
    expect(next.cache.get('a')).toBe(FILE)
    expect(next.fetchErrors.has('a')).toBe(false)
  })

  it('setError + clearError manages the error map', () => {
    const s = useHistoryExpansionStore.getState()
    s.setError('a', 'oops')
    expect(useHistoryExpansionStore.getState().fetchErrors.get('a')).toBe('oops')
    s.clearError('a')
    expect(useHistoryExpansionStore.getState().fetchErrors.has('a')).toBe(false)
  })

  it('invalidate drops cache and errors for the id', () => {
    const s = useHistoryExpansionStore.getState()
    s.setParsed('a', FILE)
    s.setError('b', 'x')
    s.invalidate('a')
    s.invalidate('b')
    const next = useHistoryExpansionStore.getState()
    expect(next.cache.has('a')).toBe(false)
    expect(next.fetchErrors.has('b')).toBe(false)
  })

  it('CA-10: collapse (direct) evicts the cached run and its error for that id', () => {
    const s = useHistoryExpansionStore.getState()
    s.expand('a')
    s.setParsed('a', FILE)
    s.setError('b', 'oops')
    s.expand('b')

    s.collapse('a')
    let next = useHistoryExpansionStore.getState()
    expect(next.cache.has('a')).toBe(false)

    s.collapse('b')
    next = useHistoryExpansionStore.getState()
    expect(next.fetchErrors.has('b')).toBe(false)
  })

  it('CA-10: collapsing via toggle also evicts the cached run', () => {
    const s = useHistoryExpansionStore.getState()
    s.expand('a')
    s.setParsed('a', FILE)

    s.toggle('a') // expanded → collapsed
    const next = useHistoryExpansionStore.getState()
    expect(next.isExpanded('a')).toBe(false)
    expect(next.cache.has('a')).toBe(false)
  })

  it('CA-11: re-expanding a collapsed row is a cache miss (re-fetch required)', () => {
    const s = useHistoryExpansionStore.getState()
    s.expand('a')
    s.setParsed('a', FILE)
    s.collapse('a')

    s.expand('a')
    const next = useHistoryExpansionStore.getState()
    expect(next.isExpanded('a')).toBe(true)
    expect(next.cache.has('a')).toBe(false)
  })

  it('reset clears all state', () => {
    const s = useHistoryExpansionStore.getState()
    s.expand('a')
    s.setParsed('a', FILE)
    s.setError('b', 'oops')
    s.reset()
    const next = useHistoryExpansionStore.getState()
    expect(next.expandedIds.size).toBe(0)
    expect(next.cache.size).toBe(0)
    expect(next.fetchErrors.size).toBe(0)
  })
})
