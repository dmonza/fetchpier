import { describe, expect, it } from 'vitest'
import { reconcileContentChange, removedFlagChanges } from './tab-reconcile'

describe('reconcileContentChange', () => {
  it('skips a lazy tab that was never loaded (no baseline)', () => {
    expect(reconcileContentChange({ cleanHash: undefined, newHash: 'abc', isDirty: false })).toBe(
      'skip'
    )
  })

  it('treats an on-disk hash equal to the baseline as a no-op (the app self-write)', () => {
    expect(reconcileContentChange({ cleanHash: 'h1', newHash: 'h1', isDirty: false })).toBe('noop')
  })

  it('reloads a clean tab when the on-disk content diverges', () => {
    expect(reconcileContentChange({ cleanHash: 'h1', newHash: 'h2', isDirty: false })).toBe(
      'reload'
    )
  })

  it('flags a conflict on a modified tab when the on-disk content diverges', () => {
    expect(reconcileContentChange({ cleanHash: 'h1', newHash: 'h2', isDirty: true })).toBe(
      'conflict'
    )
  })
})

describe('removedFlagChanges', () => {
  const never = (): boolean => false

  it('flags a file-backed tab whose path is absent from the tree', () => {
    const tabs = [{ id: '1', filePath: '/ws/a.http', removedOnDisk: false }]
    expect(removedFlagChanges(tabs, new Set<string>(), never)).toEqual([
      { id: '1', removedOnDisk: true }
    ])
  })

  it('clears the flag when the path reappears in the tree', () => {
    const tabs = [{ id: '1', filePath: '/ws/a.http', removedOnDisk: true }]
    expect(removedFlagChanges(tabs, new Set(['/ws/a.http']), never)).toEqual([
      { id: '1', removedOnDisk: false }
    ])
  })

  it('emits no change when the flag already matches the tree state', () => {
    const present = [{ id: '1', filePath: '/ws/a.http', removedOnDisk: false }]
    expect(removedFlagChanges(present, new Set(['/ws/a.http']), never)).toEqual([])
    const gone = [{ id: '2', filePath: '/ws/b.http', removedOnDisk: true }]
    expect(removedFlagChanges(gone, new Set<string>(), never)).toEqual([])
  })

  it('flags a lazy (never-loaded) tab purely by path absence', () => {
    // removedOnDisk is undefined and there is no baseline — still flag by path.
    const tabs = [{ id: '1', filePath: '/ws/a.http', removedOnDisk: undefined }]
    expect(removedFlagChanges(tabs, new Set<string>(), never)).toEqual([
      { id: '1', removedOnDisk: true }
    ])
  })

  it('ignores untitled tabs (no filePath)', () => {
    const tabs = [{ id: '1', filePath: null, removedOnDisk: false }]
    expect(removedFlagChanges(tabs, new Set<string>(), never)).toEqual([])
  })

  it('skips a path mid-flight in an in-app rename/move (no spurious flag)', () => {
    const tabs = [{ id: '1', filePath: '/ws/old.http', removedOnDisk: false }]
    const isRepointing = (p: string): boolean => p === '/ws/old.http'
    expect(removedFlagChanges(tabs, new Set<string>(), isRepointing)).toEqual([])
  })
})
