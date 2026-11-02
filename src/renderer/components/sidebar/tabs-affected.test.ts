import { describe, it, expect } from 'vitest'
import { DEFAULT_REQUEST_STATE } from '../../../shared/types'
import type { Tab, WorkspaceTree } from '../../../shared/types'
import { tabsAffectedBy } from './tabs-affected'

function tab(filePath: string | null, id = filePath ?? 'x'): Tab {
  return {
    id,
    title: id,
    filePath,
    isDirty: false,
    request: { ...DEFAULT_REQUEST_STATE },
    response: null,
    isLoading: false,
    error: null,
    requestId: `req-${id}`,
    mode: 'permanent'
  }
}

const fileNode = (path: string): WorkspaceTree =>
  ({ path, name: path.split('/').pop() ?? path, type: 'file', kind: 'request' }) as WorkspaceTree
const folderNode = (path: string): WorkspaceTree =>
  ({ path, name: path.split('/').pop() ?? path, type: 'folder' }) as WorkspaceTree

const DIR = '/ws/requests/coll'

describe('tabsAffectedBy', () => {
  it('includes the open tab backing the node itself', () => {
    const t = tab(`${DIR}/login.http`)
    expect(tabsAffectedBy([t], fileNode(`${DIR}/login.http`))).toEqual([t])
  })

  it('includes tabs nested under a folder node (rename/move of a folder)', () => {
    const under = tab(`${DIR}/sub/get.http`)
    const outside = tab('/ws/requests/other/get.http')
    expect(tabsAffectedBy([under, outside], folderNode(DIR))).toEqual([under])
  })

  it('includes an open INSTANCE tab of a request node (sibling *.instance.http)', () => {
    // Instances are siblings, not nested under the parent path — the simple
    // "under the path" check misses them (the bug this guards against).
    const instance = tab(`${DIR}/login.happy.instance.http`)
    const result = tabsAffectedBy([instance], fileNode(`${DIR}/login.http`))
    expect(result).toEqual([instance])
  })

  it('does not include an unrelated sibling request that shares a prefix', () => {
    const sibling = tab(`${DIR}/loginButton.http`)
    expect(tabsAffectedBy([sibling], fileNode(`${DIR}/login.http`))).toEqual([])
  })

  it('ignores tabs with no file (untitled / history)', () => {
    expect(tabsAffectedBy([tab(null, 'untitled')], fileNode(`${DIR}/login.http`))).toEqual([])
  })
})
