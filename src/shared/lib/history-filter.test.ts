import { describe, it, expect } from 'vitest'
import { hasHistoryRequestFilter, historyEntryMatchesFilter } from './history-filter'

const run = (requestId: string | undefined, sourceFile: string | null) => ({
  requestId,
  sourceFile
})

describe('historyEntryMatchesFilter', () => {
  it('keeps every run when neither ids nor paths are given', () => {
    expect(historyEntryMatchesFilter(run(undefined, null), {})).toBe(true)
    expect(
      historyEntryMatchesFilter(run('a', 'requests/a.http'), { requestIds: [], sourceFiles: [] })
    ).toBe(true)
  })

  it('keeps a run whose request id is one of the ids', () => {
    expect(historyEntryMatchesFilter(run('a', 'requests/x.http'), { requestIds: ['a', 'b'] })).toBe(
      true
    )
    expect(historyEntryMatchesFilter(run('c', 'requests/x.http'), { requestIds: ['a', 'b'] })).toBe(
      false
    )
    expect(
      historyEntryMatchesFilter(run(undefined, 'requests/x.http'), { requestIds: ['a'] })
    ).toBe(false)
  })

  it('keeps a run of a listed path that recorded a request id', () => {
    const filter = { sourceFiles: ['requests/col/a.http'] }
    expect(historyEntryMatchesFilter(run('random-1', 'requests/col/a.http'), filter)).toBe(true)
    expect(historyEntryMatchesFilter(run('random-1', 'requests/col/b.http'), filter)).toBe(false)
    expect(historyEntryMatchesFilter(run('random-1', null), filter)).toBe(false)
  })

  it('leaves out a run of a listed path that recorded no request id (another request of a multi-request file)', () => {
    expect(
      historyEntryMatchesFilter(run(undefined, 'requests/col/a.http'), {
        sourceFiles: ['requests/col/a.http']
      })
    ).toBe(false)
  })

  it('compares paths ignoring the separator style on either side', () => {
    expect(
      historyEntryMatchesFilter(run('r', 'requests\\col\\a.http'), {
        sourceFiles: ['requests/col/a.http']
      })
    ).toBe(true)
    expect(
      historyEntryMatchesFilter(run('r', 'requests/col/a.http'), {
        sourceFiles: ['requests\\col\\a.http']
      })
    ).toBe(true)
  })

  it('keeps a run matched by either the ids or the paths', () => {
    const filter = { requestIds: ['a'], sourceFiles: ['requests/b.http'] }
    expect(historyEntryMatchesFilter(run('a', 'requests/a.http'), filter)).toBe(true)
    expect(historyEntryMatchesFilter(run('z', 'requests/b.http'), filter)).toBe(true)
    expect(historyEntryMatchesFilter(run('z', 'requests/c.http'), filter)).toBe(false)
  })
})

describe('hasHistoryRequestFilter', () => {
  it('is on when either list is non-empty', () => {
    expect(hasHistoryRequestFilter({})).toBe(false)
    expect(hasHistoryRequestFilter({ requestIds: [], sourceFiles: [] })).toBe(false)
    expect(hasHistoryRequestFilter({ requestIds: ['a'] })).toBe(true)
    expect(hasHistoryRequestFilter({ sourceFiles: ['requests/a.http'] })).toBe(true)
  })
})
